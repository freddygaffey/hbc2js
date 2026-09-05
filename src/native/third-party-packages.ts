// src/native/third-party-packages.ts — the curated third-party native-module
// package list for `native/react-modules.jsonl` / `native/seams.jsonl`'s
// `firstParty` label (docs/specs/27-native-side.md §L4).
//
// GOVERNANCE (same pattern as `src/artifact/native-boundary-packages.ts`):
// this list is appended to ONLY via a reviewed commit that cites evidence for
// the addition (the npm package whose Android sources ship the Java package
// prefix). Never silently padded, never promoted by a builder or a heuristic.
// A package matching neither this list nor the app's own manifest prefix
// (§L4's first-party rule) is `firstParty:null` — unresolved, never guessed.
//
// Seeded from two places, cross-checked to agree (§L4 "the two channels
// agree"):
//   (a) the deps signature DB (`tools/pkgsig/db`, D17f) — where a package in
//       that DB is a known RN native module, its Java package prefix is
//       recorded here too. `tools/pkgsig/db/index.json` lists
//       `@react-native-async-storage/async-storage` (Android module under
//       `com.reactnativecommunity.asyncstorage`, the generic
//       `com.reactnativecommunity` prefix below) and
//       `react-native-gesture-handler` (Android module under
//       `com.swmansion.gesturehandler`, the `com.swmansion` prefix below) —
//       the pinned overlap `tests/gate/native/classify-party.test.ts` checks.
//   (b) the well-known RN native-module packages spec 27 §L4 names by
//       prefix, one representative npm citation each.
export interface ThirdPartyNativePackage {
  /** A Java package, matched as itself or any dot-bounded subpackage (the
   *  same "equals or is under" rule §L4 uses for the first-party prefix). */
  readonly prefix: string;
  /** The npm package whose Android sources ship a class under `prefix`. */
  readonly npmPackage: string;
  /** One-line, checkable citation for why `npmPackage` -> `prefix`. */
  readonly evidence: string;
}

export const THIRD_PARTY_NATIVE_PACKAGES: readonly ThirdPartyNativePackage[] = [
  {
    prefix: "com.oblador.keychain",
    npmPackage: "react-native-keychain",
    evidence: "react-native-keychain's Android module lives at android/src/main/java/com/oblador/keychain (KeychainModule, KeychainPackage)",
  },
  {
    prefix: "com.reactnativecommunity",
    npmPackage: "@react-native-async-storage/async-storage",
    evidence:
      "@react-native-async-storage/async-storage's Android module lives at android/src/main/java/com/reactnativecommunity/asyncstorage (AsyncStorageModule); this npm package also appears in tools/pkgsig/db/index.json, the deps-signature cross-check this list is seeded against",
  },
  {
    prefix: "com.swmansion",
    npmPackage: "react-native-gesture-handler",
    evidence: "react-native-gesture-handler's Android module lives at android/src/main/java/com/swmansion/gesturehandler",
  },
  {
    prefix: "org.reactnative",
    npmPackage: "react-native-camera",
    evidence: "react-native-camera's Android module lives at android/src/main/java/org/reactnative/camera",
  },
];
