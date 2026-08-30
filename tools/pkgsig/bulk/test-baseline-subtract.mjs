#!/usr/bin/env node
// tools/pkgsig/bulk/test-baseline-subtract.mjs — regression test for
// baseline-subtract.mjs (the D17c fix, docs/PACKAGE-SIGNATURES.md §6.4):
// asserts the ported subtraction logic reproduces, byte-for-byte at the
// exactHash-set level, the ALREADY-CHECKED-IN curated shared-DB file
// `tools/pkgsig/db/redux@4.2.1__hbc94.json` — the one real "src/deps
// pipeline" output artifact this repo has for a subtracted package (no
// live exported subtraction function exists to compare against directly,
// see baseline-subtract.mjs's header) — when fed a reconstructed "raw"
// (pre-subtraction) function/module set built from that same file's own 36
// surviving functions plus the real, checked-in baseline files' own
// functions (exactly what a genuine Metro bundle's raw fingerprint would
// contain: the package's own code plus the shared toolchain/foundation
// boilerplate every bundle from that scaffold carries).
//
// Network-free, build-free, no `src/**` touched or imported (only reads
// static JSON already committed to the repo) - runnable in isolation:
//   node tools/pkgsig/bulk/test-baseline-subtract.mjs
//
// Exit code 0 = all assertions passed, 1 = failure (message on stderr).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBaselineUnion, hasCompleteBaselineSet, subtractBaseline } from "./baseline-subtract.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const DB_DIR = join(HERE, "..", "db"); // tools/pkgsig/db — the curated shared DB, checked in

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok: ${msg}`);
  }
}

function sortedHashes(fns) {
  return [...new Set(fns.map((f) => f.exactHash))].sort();
}

function main() {
  const reduxSubtracted = readJson(join(DB_DIR, "redux@4.2.1__hbc94.json"));
  assert(reduxSubtracted.subtractedBaselines.length === 3, `fixture has 3 subtractedBaselines (got ${reduxSubtracted.subtractedBaselines.length})`);
  assert(reduxSubtracted.functions.length === reduxSubtracted.totalFunctions, "fixture's functions.length matches its own totalFunctions");

  // Reconstruct a "raw" (pre-subtraction) function/module set: redux's real
  // 36 surviving functions plus every function from the three real baseline
  // files this repo already carries for RN 0.72.17 / HBC94 - exactly what a
  // genuine unfiltered Metro bundle fingerprint would contain.
  const baselineFiles = [
    "metro-toolchain-empty@0.76.9__hbc94.json",
    "react-foundation@18.2.0__hbc94.json",
    "react-native-foundation@0.72.17__hbc94.json",
  ].map((name) => readJson(join(DB_DIR, "_baselines", name)));

  const rawFunctions = [...reduxSubtracted.functions, ...baselineFiles.flatMap((b) => b.functions)];
  // Sanity: the reconstruction actually added boilerplate, i.e. this test
  // is exercising subtraction, not a no-op.
  assert(rawFunctions.length > reduxSubtracted.functions.length, "reconstructed raw set is strictly larger than the subtracted fixture");
  // Note: rawFunctions.length (36 + the full size of all 3 baseline files)
  // is deliberately NOT compared against the fixture's own recorded
  // rawFunctionCount (124) - a real Metro bundle only includes whichever
  // baseline functions are actually reachable from redux's own require
  // graph (a subset), while this reconstruction concatenates entire
  // baseline files as a cheap, deterministic stand-in. What must match
  // exactly is the *result* of subtraction, asserted below.

  // rawModules: same modules as the fixture, but with factoryIsBaseline
  // deliberately scrambled so the assertion below actually exercises
  // subtractBaseline's own recomputation rather than trusting the input.
  const rawModules = reduxSubtracted.modules.map((m) => ({ ...m, factoryIsBaseline: false }));

  const { hashes, paths } = computeBaselineUnion(DB_DIR, 94);
  assert(hashes.size > 0, "computeBaselineUnion found a non-empty baseline hash set for hbc94");
  assert(hasCompleteBaselineSet(paths), `hasCompleteBaselineSet is true for a real 3-file baseline set (paths: ${paths.join(", ")})`);

  const { functions, modules } = subtractBaseline(rawFunctions, rawModules, hashes);

  assert(functions.length === reduxSubtracted.functions.length, `subtracted function count matches fixture (${functions.length} vs ${reduxSubtracted.functions.length})`);
  const gotHashes = sortedHashes(functions);
  const wantHashes = sortedHashes(reduxSubtracted.functions);
  assert(JSON.stringify(gotHashes) === JSON.stringify(wantHashes), "subtracted exactHash set is identical to the curated fixture's");

  const gotBaselineFlags = modules.map((m) => m.factoryIsBaseline);
  const wantBaselineFlags = reduxSubtracted.modules.map((m) => m.factoryIsBaseline);
  assert(JSON.stringify(gotBaselineFlags) === JSON.stringify(wantBaselineFlags), `recomputed factoryIsBaseline flags match the fixture's (${JSON.stringify(gotBaselineFlags)})`);
  assert(wantBaselineFlags.filter(Boolean).length === 6 && wantBaselineFlags.length === 7, "sanity: fixture has 6 baseline + 1 real module (redux's own)");

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall assertions passed");
}

main();
