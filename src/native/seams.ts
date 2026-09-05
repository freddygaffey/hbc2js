// src/native/seams.ts — spec 27 §L3: the JS<->native linkage join.
//
// One `native/seams.jsonl` row per seam, each citing BOTH sides' evidence.
// This file is a JOIN and nothing else: every JS-side signal it reads is
// already materialised by `src/artifact/*` (`index/strings.json`,
// `index/string-uses.jsonl`, `index/globals.jsonl`, `index/functions.jsonl`
// for `parent` only), and every native-side signal by
// `src/native/react-modules.ts` (`native/react-modules.jsonl`). Nothing is
// re-derived from bytecode or DEX bytes here (§L3 "all already materialised
// — never re-derived here").
//
// Anchoring (which functions are "in scope" for a channel, §4.2): a real
// Metro bundle NEVER binds `NativeModules`/`TurboModuleRegistry`/
// `requireNativeComponent` as a global — `require("react-native")` is
// always a local (`_reactNative.NativeModules.Crypto.x()`, or
// `var {NativeModules} = require(...)`), so gating on a `globals.jsonl`
// GLOBAL read (as this file used to) finds nothing on a real bundle and
// silently reports every native module `native-only`. `anchorFns` below
// anchors a function on whichever of these actually appears: a materialised
// GLOBAL read (kept for bundles/fixtures that really do use one), OR an
// exact `property-get`/`global-name` string-use of the channel's host name
// (`"NativeModules"` etc) in that function itself OR in ANY of its lexical
// ancestors (`index/functions.jsonl` `parent`, walked to full depth) — this
// covers both real shapes: the inline chain (anchor and candidate name in
// the same function) and the module-top capture consumed from a nested
// closure that carries no string-use of the host name at all (only its own
// ancestor does).
//
// Truth rules (spec 27 §4.2/§4.3):
//   - Exact name equality or nothing. A JS `Crypto` never links to a native
//     `CryptoStore`; there is no substring/fuzzy/case-insensitive matching
//     anywhere in this file.
//   - A JS reference with no native impl in this APK is emitted `js-only`
//     with `native:null` (never dropped, never guessed); a native module with
//     no JS reference is `native-only` with `jsEvidence:null`.
//   - Every row's evidence is independently checkable against the two
//     artifacts it cites (the acceptance invariant).
//
// KNOWN GAP (reported with the landing, documented in
// docs/specs/10-artifact-format.md §2.8 and docs/BUGS.md): the JS-side tables
// carry NO receiver for a host-object member chain — `index/calls-resolved.jsonl`
// resolves `require(N)` module exports only, and `string-uses.jsonl` gives the
// same `property-get` role to the `X` of `NativeModules.X` and to the `m` of
// `X.m` (`src/artifact/semantic-walk.ts` collapses both onto one role). So:
//   - every row v1 emits is `resolved:"string-only"` — the honest strength;
//   - in the `NativeModules` channel a member string that matches no native
//     module and is not consumed as a linked module's method is emitted as a
//     `js-only` seam, so an unresolved boundary is never dropped, at the cost
//     of over-reporting method names as candidate modules. A `js-only` row is
//     an *unresolved* boundary, never a claimed link, so this can never
//     fabricate a seam (§4.3's "a false seam is worse than a missing one").
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionRow, GlobalRow, StringRow, StringUseRow, StringUseRole } from "../artifact/schema.ts";
import { labelSeamParty } from "./classify-party.ts";
import {
  nativeHeader,
  toNativeJsonl,
  type NativeModuleRow,
  type SeamChannel,
  type SeamJsEvidence,
  type SeamRow,
} from "./schema.ts";

/** The JS-side rows the join reads — exactly the materialised index tables. */
export interface SeamJsTables {
  /** sid -> text (`index/strings.json`; a truncated entry has no full text and
   *  is therefore not a join key — absent, never reconstructed). */
  readonly strings: ReadonlyMap<number, string>;
  readonly stringUses: readonly StringUseRow[];
  readonly globals: readonly GlobalRow[];
  /** `index/functions.jsonl` — read ONLY for `parent` (the immediate lexical
   *  ancestor, per docs/specs/10-artifact-format.md §2.1), so a function that
   *  merely reads a captured local can still be anchored via the ancestor
   *  that bound it (see `anchorFns` below). */
  readonly functions: readonly FunctionRow[];
}

/** The host anchors, and which string-use role carries a module NAME for each.
 *  `NativeModules.X` reads `X` as a property; `TurboModuleRegistry.get("X")`
 *  and `requireNativeComponent("X")` pass it as a string literal (so their
 *  own `get`/`name` property reads are never candidates). */
const CHANNELS: readonly { readonly channel: SeamChannel; readonly global: string; readonly roles: readonly StringUseRole[] }[] = [
  { channel: "NativeModules", global: "NativeModules", roles: ["property-get"] },
  { channel: "TurboModuleRegistry", global: "TurboModuleRegistry", roles: ["literal", "call-arg-literal"] },
  { channel: "requireNativeComponent", global: "requireNativeComponent", roles: ["literal", "call-arg-literal"] },
];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Functions that read/call `global` (a write to it is shadowing, not a use —
 *  same rule `src/artifact/native.ts` applies to the host-global surface):
 *  either a materialised GLOBAL read of `global` (a bundle that never
 *  bundles the RN runtime — a plain script, or a fixture that declares the
 *  host as a top-level `var`), OR a `property-get`/`global-name` string-use
 *  of the literal text `global` in that function or ANY of its lexical
 *  ancestors (`index/functions.jsonl` `parent`, walked to whatever depth the
 *  bundle nests to — real Metro output is `require("react-native")` bound
 *  to a local, never a global, so `_rn.NativeModules...` or
 *  `var {NativeModules} = _rn;` used from a nested closure are both exact
 *  string-use matches, no substring/fuzzy matching, ever). Walking the FULL
 *  ancestor chain (not just one level) is deliberate: the depth a bundler
 *  nests a captured host reference at is not part of this join's contract. */
function anchorFns(js: SeamJsTables, global: string): Set<number> {
  const direct = new Set<number>();
  for (const g of js.globals) {
    if (g.g === global && g.access !== "write") direct.add(g.fn);
  }
  for (const use of js.stringUses) {
    if (use.role !== "property-get" && use.role !== "global-name") continue;
    if (js.strings.get(use.sid) === global) direct.add(use.fn);
  }

  const parentOf = new Map<number, number | null>();
  for (const f of js.functions) parentOf.set(f.fn, f.parent);

  const memo = new Map<number, boolean>();
  const isAnchored = (fn: number): boolean => {
    if (direct.has(fn)) return true;
    const cached = memo.get(fn);
    if (cached !== undefined) return cached;
    memo.set(fn, false); // cycle guard: an in-progress fn is provisionally "not anchored"
    const parent = parentOf.get(fn) ?? null;
    const result = parent !== null && isAnchored(parent);
    memo.set(fn, result);
    return result;
  };

  const out = new Set<number>();
  const candidates = new Set<number>([...direct, ...parentOf.keys()]);
  for (const fn of candidates) if (isAnchored(fn)) out.add(fn);
  return out;
}

/** fn -> (candidate name -> the sid it was seen as), for one channel. */
function candidatesByFn(js: SeamJsTables, channel: (typeof CHANNELS)[number]): Map<number, Map<string, number>> {
  const fns = anchorFns(js, channel.global);
  const out = new Map<number, Map<string, number>>();
  if (fns.size === 0) return out;
  for (const use of js.stringUses) {
    if (!fns.has(use.fn) || !channel.roles.includes(use.role)) continue;
    const text = js.strings.get(use.sid);
    // The anchor's own name (e.g. "NativeModules" itself, read as a
    // property-get off the captured host local) is never a candidate module
    // name — only relevant when it shares a role with real candidates (the
    // NativeModules channel's own `property-get` role).
    if (text === undefined || text.length === 0 || text === channel.global) continue;
    const perFn = out.get(use.fn) ?? new Map<string, number>();
    if (!perFn.has(text)) perFn.set(text, use.sid);
    out.set(use.fn, perFn);
  }
  return out;
}

function evidence(sids: ReadonlySet<number>, fns: ReadonlySet<number>): SeamJsEvidence {
  return {
    stringUses: [...sids].sort((a, b) => a - b).map((s) => `sid:${s}`),
    callSites: [...fns].sort((a, b) => a - b).map((f) => `fn:${f}`),
    // See this file's KNOWN GAP note: no materialised receiver exists yet.
    resolved: "string-only",
  };
}

/** Join `js` (or nothing at all) against L2's module rows. Pure: same rows in,
 *  same rows out, in `key` order. */
export function buildSeams(js: SeamJsTables | null, modules: readonly NativeModuleRow[]): SeamRow[] {
  const byName = new Map<string, NativeModuleRow[]>();
  for (const m of modules) {
    if (m.jsName === null) continue;
    const list = byName.get(m.jsName);
    if (list === undefined) byName.set(m.jsName, [m]);
    else list.push(m);
  }
  for (const list of byName.values()) list.sort((a, b) => cmp(a.implClass, b.implClass));

  const rows: SeamRow[] = [];
  const linkedModuleKeys = new Set<string>();
  const used = new Set<string>(); // emitted keys, for deterministic disambiguation

  const emit = (row: Omit<SeamRow, "key"> & { key: string }): void => {
    let key = row.key;
    for (let n = 2; used.has(key); n++) key = `${row.key}~${n}`;
    used.add(key);
    rows.push({ ...row, key });
  };

  if (js !== null) {
    for (const channel of CHANNELS) {
      const perFn = candidatesByFn(js, channel);

      // Names seen in this channel: name -> {fns, sids}.
      const refs = new Map<string, { fns: Set<number>; sids: Set<number> }>();
      for (const [fn, names] of perFn) {
        for (const [name, sid] of names) {
          const ref = refs.get(name) ?? { fns: new Set<number>(), sids: new Set<number>() };
          ref.fns.add(fn);
          ref.sids.add(sid);
          refs.set(name, ref);
        }
      }

      // A member string that is an exported method of a module linked in the
      // SAME function is that module's method, not a module of its own (a
      // two-sided exact-name join, never a name heuristic).
      const consumedAsMethod = new Set<string>();
      for (const [, names] of perFn) {
        for (const name of names.keys()) {
          const mods = byName.get(name);
          if (mods === undefined) continue;
          for (const mod of mods) for (const method of mod.methods) if (names.has(method.jsName)) consumedAsMethod.add(method.jsName);
        }
      }

      for (const name of [...refs.keys()].sort(cmp)) {
        const ref = refs.get(name)!;
        const mods = byName.get(name);
        if (mods === undefined) {
          if (consumedAsMethod.has(name)) continue;
          emit({
            key: `seam:${name}`,
            jsName: name,
            jsMethod: null,
            jsEvidence: evidence(ref.sids, ref.fns),
            native: null,
            status: "js-only",
            channel: channel.channel,
            firstParty: null,
          });
          continue;
        }
        for (const mod of mods) {
          linkedModuleKeys.add(mod.key);
          // Methods observed on the JS side: an exported native method name
          // used as a member in a function that references this module.
          const observed = new Map<string, { sids: Set<number>; fns: Set<number> }>();
          for (const [fn, names] of perFn) {
            if (!names.has(name)) continue;
            for (const method of mod.methods) {
              const sid = names.get(method.jsName);
              if (sid === undefined) continue;
              const seen = observed.get(method.jsName) ?? { sids: new Set<number>(), fns: new Set<number>() };
              seen.sids.add(sid);
              seen.sids.add(names.get(name)!);
              seen.fns.add(fn);
              observed.set(method.jsName, seen);
            }
          }
          if (observed.size === 0) {
            emit({
              key: `seam:${name}`,
              jsName: name,
              jsMethod: null,
              jsEvidence: evidence(ref.sids, ref.fns),
              native: { module: mod.key, method: null },
              status: "linked",
              channel: channel.channel,
              firstParty: null,
            });
            continue;
          }
          for (const methodName of [...observed.keys()].sort(cmp)) {
            const seen = observed.get(methodName)!;
            const nativeMethod = mod.methods.find((m) => m.jsName === methodName)!;
            emit({
              key: `seam:${name}.${methodName}`,
              jsName: name,
              jsMethod: methodName,
              jsEvidence: evidence(seen.sids, seen.fns),
              native: { module: mod.key, method: nativeMethod.nativeMethod },
              status: "linked",
              channel: channel.channel,
              firstParty: null,
            });
          }
        }
      }
    }
  }

  // Native modules no JS reference reached (including a module whose own name
  // could not be recovered: it is still a real, unlinked native module).
  for (const mod of [...modules].sort((a, b) => cmp(a.key, b.key))) {
    if (linkedModuleKeys.has(mod.key)) continue;
    emit({
      key: `seam:${mod.jsName ?? mod.key}`,
      jsName: mod.jsName,
      jsMethod: null,
      jsEvidence: null,
      native: { module: mod.key, method: null },
      status: "native-only",
      channel: null,
      firstParty: null,
    });
  }

  rows.sort((a, b) => cmp(a.key, b.key));
  return rows;
}

function parseJsonl(text: string): unknown[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.slice(1).map((l) => JSON.parse(l) as unknown); // line 0 is the index header
}

/** Read the three JS-side index tables out of an artifact directory, or
 *  `null` when this directory holds no JS artifact (§L3: `seams.jsonl` exists
 *  only when BOTH sides do). */
export function readJsSeamTables(artifactDir: string): SeamJsTables | null {
  const stringsPath = join(artifactDir, "index", "strings.json");
  const usesPath = join(artifactDir, "index", "string-uses.jsonl");
  const globalsPath = join(artifactDir, "index", "globals.jsonl");
  const functionsPath = join(artifactDir, "index", "functions.jsonl");
  if (!existsSync(stringsPath) || !existsSync(usesPath) || !existsSync(globalsPath) || !existsSync(functionsPath)) return null;
  const parsed = JSON.parse(readFileSync(stringsPath, "utf8")) as { entries?: readonly StringRow[] };
  const strings = new Map<number, string>();
  for (const e of parsed.entries ?? []) {
    if ("v" in e) strings.set(e.sid, e.v);
  }
  return {
    strings,
    stringUses: parseJsonl(readFileSync(usesPath, "utf8")) as StringUseRow[],
    globals: parseJsonl(readFileSync(globalsPath, "utf8")) as GlobalRow[],
    functions: parseJsonl(readFileSync(functionsPath, "utf8")) as FunctionRow[],
  };
}

export function serialiseSeams(rows: readonly SeamRow[]): string {
  return toNativeJsonl(nativeHeader("seams", "join"), rows);
}

/** Write `<artifactDir>/native/seams.jsonl` when a JS artifact is present.
 *  Returns the rows written, or `null` when there is no JS half (no file is
 *  written then — an absent seam table says "not joinable", which is the
 *  truth, rather than a table of native-only rows pretending to be a join). */
export function writeSeams(artifactDir: string, modules: readonly NativeModuleRow[]): { rows: SeamRow[]; text: string } | null {
  const js = readJsSeamTables(artifactDir);
  if (js === null) return null;
  // spec 27 §L4: `modules` is already party-labelled by the caller
  // (`ingest.ts`); a seam row inherits its native module's label, never
  // re-classifies (a join file joins, it does not re-derive a label).
  const rows = labelSeamParty(buildSeams(js, modules), modules);
  const text = serialiseSeams(rows);
  writeFileSync(join(artifactDir, "native", "seams.jsonl"), text);
  return { rows, text };
}
