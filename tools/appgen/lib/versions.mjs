// tools/appgen/lib/versions.mjs — RN-release -> HBC-version pin table for
// the app-gen fuzzer's version-rotation axis (docs/specs/09-fuzzing.md §2.1
// "RN + Hermes version" row; increment-2 task brief item 1).
//
// The mapping is DERIVED, not assumed (spec §2.1): docs/TOOLCHAIN.md's
// version table records, per pinned RN release, which package ships that
// release's own hermesc and where it lives inside node_modules once that
// release is npm-installed. Two distribution mechanisms exist (see
// docs/TOOLCHAIN.md's "distribution-mechanism" section):
//   - RN <= 0.82: hermesc ships inside react-native itself, at
//     node_modules/react-native/sdks/hermesc/<osdir>/hermesc.
//   - RN >= 0.83: hermesc moved to its own package, `hermes-compiler`, a
//     dependency of react-native, hoisted to node_modules/hermes-compiler/
//     hermesc/<osdir>/hermesc by a normal npm install.
export function hermescPathForRn(rnVersion) {
  const [major, minor] = rnVersion.split(".").map(Number);
  // RN "1000.x" (post-renumbering "99" line) also uses the new mechanism.
  const usesHermesCompilerPkg = major >= 1000 || major > 0 || (major === 0 && minor >= 83);
  return (workspace, osdir) =>
    usesHermesCompilerPkg
      ? `${workspace}/node_modules/hermes-compiler/hermesc/${osdir}/hermesc`
      : `${workspace}/node_modules/react-native/sdks/hermesc/${osdir}/hermesc`;
}

/** Pinned RN releases this fuzzer knows how to build, keyed by the HBC
 *  version their own hermesc emits (docs/TOOLCHAIN.md's version table).
 *  v84 is explicitly out of scope for B (spec §2.1: "v84 is legacy"). */
export const RN_PINS = {
  96: {
    rnVersion: "0.73.11",
    hbcVersion: 96,
    compiler: "project-hermesc",
    note: "docs/TOOLCHAIN.md: react-native@0.73.11 -> HBC 96 (sdks/hermesc)",
  },
  98: {
    rnVersion: "0.86.0",
    hbcVersion: 98,
    compiler: "project-hermesc",
    note:
      "docs/TOOLCHAIN.md: react-native@0.86.0 depends on hermes-compiler@250829098.0.14, " +
      "class E (\"98-late\") layout (Review-confirmed 2026-09-02, spec §2.1)",
    // Fallback provenance marker: if the pinned RN 0.86/0.87 project fails
    // to build twice, compile the Metro bundle of a buildable generated app
    // directly with tools/hermesc/v98/hermesc (spec §2.1 fallback clause).
    directHermescFallback: "tools/hermesc/v98/hermesc",
  },
};

export const DEFAULT_RN_PIN = RN_PINS[96];
