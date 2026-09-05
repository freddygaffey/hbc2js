// src/native/classify-party.ts — spec 27 §L4: first-party vs third-party
// labelling of a native class's implementing package.
//
// Decisions pending Fred (docs/specs/27-native-side.md §5 items 2-3; taken
// here so L4 could land, stated for ratification, never silently assumed
// final):
//   - First-party rule = the impl class's Java package equals, or is a
//     dot-bounded subpackage of, the AndroidManifest `package=` prefix. No
//     per-app allow/deny list yet.
//   - Third-party seed list = ONLY `third-party-packages.ts`'s curated,
//     evidence-cited entries (seeded from + cross-checked against the deps
//     signature DB, `tools/pkgsig/db`). Not padded with every known RN
//     native-module package.
//   - Order: third-party is checked first (§L4 calls it "high reliability"),
//     then first-party, else `null` — never guessed either way.
import { THIRD_PARTY_NATIVE_PACKAGES } from "./third-party-packages.ts";
import type { NativeModuleRow, SeamRow } from "./schema.ts";

/** `native:type:Lcom/x/Foo;` (an `implClass` field) -> `Lcom/x/Foo;`, or
 *  `null` when `key` is not a `native:type:` key at all. */
export function typeDescriptorOfKey(key: string): string | null {
  const prefix = "native:type:";
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/** `Lcom/x/Foo;` -> `com.x`, the dotted Java package of a type descriptor.
 *  `null` when `descriptor` is not `L...;`-shaped; `""` for the default
 *  (unnamed) package rather than `null` — a real, if unusual, fact. */
export function packageOfDescriptor(descriptor: string): string | null {
  const m = /^L([^;]*);$/.exec(descriptor);
  if (m === null) return null;
  const path = m[1]!;
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "";
  return path.slice(0, slash).split("/").join(".");
}

/** True when dotted package `pkg` equals `prefix`, or is a subpackage of it
 *  (`pkg === prefix` or `pkg` starts with `prefix + "."`) — the one "equals
 *  or is under" rule §L4 uses for both the first- and third-party checks.
 *  Dot-bounded so `com.swmansion2.x` never matches prefix `com.swmansion`. */
export function isUnderJavaPackage(pkg: string, prefix: string): boolean {
  return pkg === prefix || pkg.startsWith(`${prefix}.`);
}

/** The curated third-party prefix `pkg` falls under, or `null`. */
function thirdPartyPrefixMatch(pkg: string): string | null {
  for (const entry of THIRD_PARTY_NATIVE_PACKAGES) {
    if (isUnderJavaPackage(pkg, entry.prefix)) return entry.prefix;
  }
  return null;
}

/** §L4's classification of one native class's package: `false` when it falls
 *  under a curated third-party prefix, `true` when it falls under the app's
 *  own manifest package, `null` when neither applies (unresolved — surfaced
 *  for the human, never forced) or `implClassKey`/`manifestPackage` do not
 *  parse into a real package at all. */
export function classifyParty(implClassKey: string, manifestPackage: string | null): boolean | null {
  const descriptor = typeDescriptorOfKey(implClassKey);
  if (descriptor === null) return null;
  const pkg = packageOfDescriptor(descriptor);
  if (pkg === null) return null;
  if (thirdPartyPrefixMatch(pkg) !== null) return false;
  if (manifestPackage !== null && isUnderJavaPackage(pkg, manifestPackage)) return true;
  return null;
}

/** Fill `firstParty` on every `native/react-modules.jsonl` row (spec 27 §L4).
 *  Pure: same rows + same manifest package in, same rows out (§4.1). */
export function labelReactModuleParty(modules: readonly NativeModuleRow[], manifestPackage: string | null): NativeModuleRow[] {
  return modules.map((m) => ({ ...m, firstParty: classifyParty(m.implClass, manifestPackage) }));
}

/** Fill `firstParty` on every `native/seams.jsonl` row from the ALREADY
 *  party-labelled module rows (never re-classified here): a `linked` or
 *  `native-only` row inherits its native module's label; a `js-only` row has
 *  no native class to classify and stays `null` (spec 27 §L4 "unresolved").
 *  Pure, and independent of `buildSeams`'s join logic (§L3 is a join, §L4 is
 *  a label — kept as two passes so neither has to know the other's rules). */
export function labelSeamParty(seams: readonly SeamRow[], labelledModules: readonly NativeModuleRow[]): SeamRow[] {
  const byKey = new Map(labelledModules.map((m) => [m.key, m] as const));
  return seams.map((s) => {
    if (s.native === null) return s;
    const mod = byKey.get(s.native.module);
    return { ...s, firstParty: mod === undefined ? null : mod.firstParty };
  });
}
