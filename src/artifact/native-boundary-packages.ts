// src/artifact/native-boundary-packages.ts — the curated native-boundary
// package list for `native.jsonl`'s `bridge-module` surface (docs/specs/
// 10-artifact-format.md §2.5). In-repo data file, same governance pattern as
// `./host-globals.ts` (§9 ruling 2): appended to only via a reviewed commit
// citing evidence for the addition, never silently promoted by the builder.
//
// A module classifies as a native-boundary package when `src/deps/classify.ts`
// names it (`ModuleClassification.libraryPackageHint`) as one of these bare
// package names — the packages whose entire reason for existing is to bridge
// JS to native/host code, not just "some npm library". Kept deliberately
// small and literal to the spec's own example list (§2.5: "react-native,
// expo-modules-core, …") rather than every RN-ecosystem package — a native
// UI/gesture/animation library (react-native-reanimated, react-native-screens,
// …) is real native surface too but is not yet in scope here; extending this
// list is additive and evidence-cited, never a re-interpretation.
export const NATIVE_BOUNDARY_PACKAGES: readonly string[] = ["react-native", "expo-modules-core"];

export const NATIVE_BOUNDARY_PACKAGES_SET: ReadonlySet<string> = new Set(NATIVE_BOUNDARY_PACKAGES);
