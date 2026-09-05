// src/native/env.ts — `.env` recovery from strings.xml / BuildConfig.
// docs/specs/27-native-side.md §L6: `react-native-config` bakes `.env` into
// `res/values/strings.xml` (a plain ARSC string resource) and a `BuildConfig`
// class of `static final String` fields. This module joins L1's already
// -materialised `resources.jsonl` rows and a bounded set of `BuildConfig`
// static-field facts into `native/env.jsonl` -- it re-derives nothing from
// bytes itself (`source: "join"` on the header, exactly like `seams.jsonl`).
//
// Truth rule (spec 27 §1.4 / §4.2): `strings.xml` values are always plain
// ARSC data, so that channel is either a row with a real value or no row at
// all (never an "unresolved" strings.xml row). A `BuildConfig` field's value
// lives in `static_values` (a compile-time-constant literal, read by L1's DEX
// parser) OR is only ever assigned in `<clinit>` -- a method body this parser
// does not read (spec 27 §1.2's documented gap). In the latter case the row
// is still emitted, `value:"unresolved"`, `resolvedBy:"none"` -- the key is a
// real fact even when the value is not.
import type { EnvRow, NativeResourceRow } from "./schema.ts";

/** The env-key shape spec 27 §L6 names: all-caps + underscores (and digits).
 *  A *label/filter* for the `strings.xml` channel only -- it never gates
 *  whether a string resource is available (every one already is, in
 *  `resources.jsonl`); it only decides which ones are ALSO surfaced as an
 *  `.env` candidate in `env.jsonl`. */
const ENV_KEY_SHAPE = /^[A-Z][A-Z0-9_]*$/;

export function looksLikeEnvKey(name: string): boolean {
  return ENV_KEY_SHAPE.test(name);
}

/** The DEX type descriptor for `java.lang.String`, as it appears verbatim in
 *  `DexClass.staticFields[].type` (see `dex.ts`). */
const JAVA_LANG_STRING = "Ljava/lang/String;";

/** A `BuildConfig`-shaped static field, already read from the DEX class-data
 *  tables (never a method-body read). `value` is the `static_values`
 *  compile-time-constant literal when one exists, `undefined` when the field
 *  carries no encoded initial value in this DEX (spec 27 §1.2's gap: it is,
 *  or may be, only assigned in `<clinit>`). */
export interface BuildConfigField {
  readonly className: string; // DEX type descriptor, e.g. Lcom/example/app/BuildConfig;
  readonly name: string;
  readonly type: string; // DEX type descriptor
  readonly value?: unknown;
}

/** `Lcom/x/BuildConfig;` -> true. Matched purely by the class's simple name,
 *  the react-native-config / AGP generated-class convention -- never a
 *  guess about what the class contains. */
export function isBuildConfigClass(classDescriptor: string): boolean {
  return /\/BuildConfig;$/.test(classDescriptor);
}

/** The last `/`-separated segment of a `native:res:<pkg>/<type>/<name>` key
 *  (see `src/name-overlay/id.ts`'s `nativeResourceKey`). */
function resourceName(key: string): string {
  const i = key.lastIndexOf("/");
  return i === -1 ? key : key.slice(i + 1);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Build `native/env.jsonl` rows from L1's already-materialised
 *  `resources.jsonl` rows and a bounded set of `BuildConfig` static-field
 *  facts. Pure: same inputs, same rows -- no clock, no environment. */
export function buildEnvRows(resources: readonly NativeResourceRow[], buildConfigFields: readonly BuildConfigField[]): EnvRow[] {
  const rows: EnvRow[] = [];

  // strings.xml channel: every "string" resource whose name looks like an
  // env key AND resolves to a plain string value (never a ref, never an
  // unresolved bag/style entry -- those are simply not a recovered env row).
  const byName = new Map<string, NativeResourceRow>();
  for (const r of resources) {
    if (r.type !== "string") continue;
    const name = resourceName(r.key);
    if (!looksLikeEnvKey(name)) continue;
    if (typeof r.value !== "string") continue;
    const existing = byName.get(name);
    // Prefer the `default` config's value when a key has more than one
    // (locale/orientation variants); otherwise keep the first seen (rows
    // arrive pre-sorted by key then config -- deterministic either way).
    if (existing === undefined || existing.config !== "default") byName.set(name, r);
  }
  for (const [name, r] of byName) {
    rows.push({ key: name, value: r.value as string, source: "strings.xml", resolvedBy: "own-parser" });
  }

  // BuildConfig channel: every static final String field of a BuildConfig
  // class, resolved when it has a static_values literal, else key-only.
  for (const f of buildConfigFields) {
    if (f.type !== JAVA_LANG_STRING) continue;
    if (typeof f.value === "string") {
      rows.push({ key: f.name, value: f.value, source: "BuildConfig", resolvedBy: "own-parser" });
    } else {
      rows.push({ key: f.name, value: "unresolved", source: "BuildConfig", resolvedBy: "none" });
    }
  }

  rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.source, b.source));
  return rows;
}
