// src/native/native-deps.ts — spec 27 §L7: the second, near-100% npm-package
// identification channel. A native module registers under a literal Java
// package name (`com.oblador.keychain.KeychainPackage`); when that package is
// one of the curated third-party prefixes, we already know the npm package
// that ships it (`third-party-packages.ts`'s `npmPackage` field, §L4). L7's
// job is purely to (a) resolve a `native/react-modules.jsonl` row to that npm
// name and (b) merge the result with `src/deps`'s independent JS-fingerprint
// channel, de-duplicating by npm package name.
//
// GOVERNANCE: this file deliberately does NOT keep a second curated
// prefix -> npm-name list. `third-party-packages.ts` already IS that table
// (prefix, npmPackage, one-line evidence per row) — cross-checked against
// `tools/pkgsig/db` per §L4's own test. Duplicating it here would let the two
// lists drift apart, which is exactly the failure mode §L7's "two channels
// agree" merge exists to catch. So `nativePackageForImplClass` below reads
// `THIRD_PARTY_NATIVE_PACKAGES` directly; there is nothing to pad.
import { isUnderJavaPackage, packageOfDescriptor, typeDescriptorOfKey } from "./classify-party.ts";
import { THIRD_PARTY_NATIVE_PACKAGES } from "./third-party-packages.ts";
import type { NativeModuleRow } from "./schema.ts";

/** One npm package identified from the native side, merged against whatever
 *  `src/deps`'s JS-fingerprint channel already knows about it. */
export interface NativeChannelDep {
  readonly package: string;
  /** `"both"` when `src/deps`'s JS-fingerprint channel also names this
   *  package; `"native-only"` when only the native side found it (the
   *  `cross-platform-reconstruction-IDEAS.md` "deps recall is partial" tail
   *  this lands to close). */
  readonly channel: "both" | "native-only";
  /** `["native-package"]` alone for `channel:"native-only"`;
   *  `["native-package","js-fingerprint"]` for `channel:"both"` (spec 27
   *  §L7's exact evidence-tag pair). */
  readonly evidence: readonly ("native-package" | "js-fingerprint")[];
  /** How many `native/react-modules.jsonl` rows resolved to this package
   *  (usually 1; >1 when a package registers more than one native module). */
  readonly nativeModuleCount: number;
}

/** The whole native dependency channel, ready to be spliced into
 *  `DepsReport.nativeChannel` (spec 27 §L7 "no new top-level artifact
 *  file"). */
export interface NativeChannelReport {
  readonly deps: readonly NativeChannelDep[];
}

/** Resolve one `native/react-modules.jsonl` row's `implClass` (a
 *  `native:type:Lcom/x/Foo;` key) to the npm package that ships it, via the
 *  curated third-party prefix table — or `null` when `implClass` does not
 *  fall under any curated prefix (includes every first-party and every
 *  genuinely-unknown class: §L7 "an app-namespace or unknown package is not
 *  an npm dep"). */
export function nativePackageForImplClass(implClass: string): string | null {
  const descriptor = typeDescriptorOfKey(implClass);
  if (descriptor === null) return null;
  const pkg = packageOfDescriptor(descriptor);
  if (pkg === null) return null;
  for (const entry of THIRD_PARTY_NATIVE_PACKAGES) {
    if (isUnderJavaPackage(pkg, entry.prefix)) return entry.npmPackage;
  }
  return null;
}

/** Build the native dependency channel from L4-labelled `reactModules` rows
 *  and merge it against `jsFoundPackages` — the npm package names `src/deps`
 *  already produced (any of confirmed/guessed/hinted; §L7 does not
 *  distinguish which JS-side tier found it, only that it did). Pure: no I/O,
 *  no clock (§4.1). A `firstParty:true` row is never resolved to an npm
 *  package at all (§L7's fourth test) — first-party is a custom module,
 *  never a dependency, regardless of what its package name happens to look
 *  like. */
export function buildNativeChannel(reactModules: readonly NativeModuleRow[], jsFoundPackages: ReadonlySet<string>): NativeChannelReport {
  const counts = new Map<string, number>();
  for (const row of reactModules) {
    if (row.firstParty === true) continue;
    const npmPackage = nativePackageForImplClass(row.implClass);
    if (npmPackage === null) continue;
    counts.set(npmPackage, (counts.get(npmPackage) ?? 0) + 1);
  }
  const deps: NativeChannelDep[] = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([npmPackage, nativeModuleCount]) => {
      const bothChannels = jsFoundPackages.has(npmPackage);
      return {
        package: npmPackage,
        channel: bothChannels ? "both" : "native-only",
        evidence: bothChannels ? (["native-package", "js-fingerprint"] as const) : (["native-package"] as const),
        nativeModuleCount,
      };
    });
  return { deps };
}
