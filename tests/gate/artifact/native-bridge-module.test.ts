// tests/gate/artifact/native-bridge-module.test.ts — docs/specs/
// 10-artifact-format.md §2.5 `bridge-module` surface (docs/BUGS.md
// "P2.1 §8 steps 3-5 implementation" row, `src/artifact/native.ts`).
//
// Two layers, on purpose (CLAUDE.md testing rules: no exact-output compares
// against a shared fixture's whole decompile):
//  - a pure unit test of the classification -> row mapping
//    (`nativeBoundaryModuleIds`/`buildNativeIndex`) with an injected
//    `ClassificationReport` — the fast, fixture-independent path;
//  - an end-to-end fixture test on the committed rn-template bundle: a REAL
//    `require` edge from real bytecode (`calls.jsonl` `kind:"require"`),
//    reused verbatim by `writeArtifact`'s `opts.classification` hook (the
//    same "takes (or builds) a ClassificationReport" the spec describes) —
//    proves the wiring end-to-end without depending on `classify.ts`'s
//    string-evidence signals actually firing on THIS particular optimised
//    Metro bundle (measured: they don't — node_modules paths are stripped,
//    see `src/deps/classify.ts`'s own file header).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { buildNativeIndex, nativeBoundaryModuleIds } from "../../../src/artifact/native.ts";
import { NATIVE_BOUNDARY_PACKAGES_SET } from "../../../src/artifact/native-boundary-packages.ts";
import { summarizeClassifications, type ClassificationReport, type ModuleClassification } from "../../../src/deps/classify.ts";
import type { CallRow } from "../../../src/artifact/schema.ts";

function libraryClassification(localModuleId: number, libraryPackageHint: string | null): ModuleClassification {
  return {
    localModuleId,
    factoryFunctionIndex: localModuleId,
    instrCount: 100,
    classification: "library",
    signal: "node-modules-path",
    confidence: 0.95,
    recurrenceCount: 0,
    libraryPackageHint,
  };
}

function reportFrom(modules: readonly ModuleClassification[]): ClassificationReport {
  return { modules, summary: summarizeClassifications(modules), commonalityIndexBundleCount: 0, appVocabularySize: 0 };
}

test("NATIVE_BOUNDARY_PACKAGES_SET names react-native and expo-modules-core (spec §2.5's own example list)", () => {
  assert.ok(NATIVE_BOUNDARY_PACKAGES_SET.has("react-native"));
  assert.ok(NATIVE_BOUNDARY_PACKAGES_SET.has("expo-modules-core"));
});

test("nativeBoundaryModuleIds: only library modules with a native-boundary libraryPackageHint are named", () => {
  const report = reportFrom([
    libraryClassification(1, "react-native"),
    libraryClassification(2, "expo-modules-core"),
    libraryClassification(3, "lodash"), // library, but not a native-boundary package
    { ...libraryClassification(4, "react-native"), classification: "custom" }, // hint present but not classified library
  ]);
  const ids = nativeBoundaryModuleIds(report);
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2]);
});

test("nativeBoundaryModuleIds: undefined report (no classification available) never guesses — empty set", () => {
  assert.equal(nativeBoundaryModuleIds(undefined).size, 0);
});

test("buildNativeIndex: bridge-module row mirrors calls.jsonl's require callee, aggregated per (fn, name)", () => {
  const calls: CallRow[] = [
    { caller: 10, site: 0, callee: "m:1", kind: "require" },
    { caller: 10, site: 1, callee: "m:1", kind: "require" }, // same fn, same target -> n:2
    { caller: 10, site: 2, callee: "m:2", kind: "require" }, // not in the bridge set -> no row
    { caller: 20, site: 0, callee: "m:1", kind: "require" },
  ];
  const bridgeModuleIds = new Set([1]);
  const rows = buildNativeIndex(calls, [], bridgeModuleIds);
  const bridgeRows = rows.filter((r) => r.surface === "bridge-module");
  assert.deepEqual(
    bridgeRows.map((r) => [r.fn, r.name, r.n]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    [
      [10, "m:1", 2],
      [20, "m:1", 1],
    ],
  );
});

test("buildNativeIndex: no bridgeModuleIds (default) emits zero bridge-module rows — truth rule", () => {
  const calls: CallRow[] = [{ caller: 10, site: 0, callee: "m:1", kind: "require" }];
  const rows = buildNativeIndex(calls, []);
  assert.equal(rows.filter((r) => r.surface === "bridge-module").length, 0);
});

test("rn-template-0.72 (real bundle): a real require edge, classified as react-native, produces a native.jsonl bridge-module row", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.debug.hbc" });
  // A real `require` edge from this bundle's own calls.jsonl (verified once
  // by inspection, pinned here): fn 74 requires local module 1 at site 0.
  const REQUIRING_FN = 74;
  const REQUIRED_MODULE_ID = 1;
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-bridge-module-"));
  try {
    const written = writeArtifact({
      bytes,
      splitResult,
      outDir,
      passes: {},
      strictEnv: false,
      form: "flat",
      classification: reportFrom([libraryClassification(REQUIRED_MODULE_ID, "react-native")]),
    });
    assert.ok(written.nativeCount > 0);
    const native = readFileSync(join(outDir, "index", "native.jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    const bridgeRows = native.filter((r) => r.surface === "bridge-module");
    assert.ok(bridgeRows.length > 0, "expected at least one bridge-module row");
    assert.ok(bridgeRows.some((r) => r.fn === REQUIRING_FN && r.name === `m:${REQUIRED_MODULE_ID}`));
    for (const r of bridgeRows) assert.equal(r.name.startsWith("m:"), true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("rn-template-0.72 (real bundle): no classification supplied -> classifies from the bundle's own inventory, zero bridge-module rows never guessed", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.debug.hbc"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.debug.hbc" });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-bridge-module-default-"));
  try {
    // Measured (docs/AGENT-LOG.md): this optimised/Metro-bundled fixture's
    // own inventory never trips classify.ts's string-evidence signals for
    // "react-native" (node_modules paths are stripped from the release-shaped
    // bundle) — the default (no classification supplied) path is exercised
    // here for real, and is expected to be honest-but-empty on this fixture,
    // never a guessed row.
    const written = writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
    const native = readFileSync(join(outDir, "index", "native.jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    assert.equal(native.filter((r) => r.surface === "bridge-module").length, 0);
    assert.equal(written.nativeCount, native.length);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
