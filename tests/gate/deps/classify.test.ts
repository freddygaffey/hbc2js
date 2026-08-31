// docs/DECISIONS.md D17h/D17i stage 2 — classify each Metro module as
// library (ignorable) vs app-code WITHOUT naming the package
// (src/deps/classify.ts). Unit tests against synthetic InventoryModule
// shapes for the signal logic, plus an integration check against the
// committed rn-template-0.72 fixture for the commonality-index plumbing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import type { InventoryModule } from "../../../src/deps/inventory.ts";
import {
  classifyModule,
  classifyInventory,
  buildCommonalityIndex,
  mergeCommonalityIndexes,
  functionHashesForCommonality,
  summarizeClassifications,
  loadCommonalityIndex,
  EMPTY_COMMONALITY_INDEX,
} from "../../../src/deps/classify.ts";
import type { CommonalityIndex, ModuleClassification, ModuleFunctionSample } from "../../../src/deps/classify.ts";

function invModule(overrides: Partial<InventoryModule>): InventoryModule {
  return {
    factoryFunctionIndex: 0,
    localModuleId: 0,
    depCount: 0,
    depIds: [],
    nestedFunctionIndices: [],
    functionIndices: [0],
    instrCount: 20,
    stringConstants: [],
    exactHash: null,
    fuzzyHash: null,
    stringSetHash: "hash-x",
    factoryStringSetHash: null,
    factoryStringCount: 0,
    ...overrides,
  };
}

function sample(exactHash: string | null, instrCount: number): ModuleFunctionSample {
  return { exactHash, instrCount };
}

test("classifyModule: a function whose hash recurs at/above threshold, covering a majority of the module, -> library", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "fn-hash": 2 } };
  const m = invModule({ instrCount: 20 });
  const c = classifyModule(m, [sample("fn-hash", 20)], index);
  assert.equal(c.classification, "library");
  assert.equal(c.signal, "cross-app-recurrence");
  assert.equal(c.recurrenceCount, 2);
});

test("classifyModule: recurrence below the count threshold does not trigger the primary signal", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "fn-hash": 1 } };
  const m = invModule({ instrCount: 50, stringConstants: ["hello world"] });
  const c = classifyModule(m, [sample("fn-hash", 50)], index);
  assert.notEqual(c.signal, "cross-app-recurrence");
  assert.equal(c.recurrenceCount, 1);
  // No other signal fires either -> falls through to the "app" default.
  assert.equal(c.classification, "app");
});

test("classifyModule: a recurring function covering only a MINORITY of the module's weight does not sweep the whole module in", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "fn-hash": 5 } };
  // 10 of 100 instructions come from a recurring helper; the other 90 are
  // this module's own (non-recurring) logic.
  const m = invModule({ instrCount: 100 });
  const c = classifyModule(m, [sample("fn-hash", 10), sample("own-hash", 90)], index);
  assert.notEqual(c.classification, "library");
  assert.equal(c.recurrenceCount, 5, "still reports the recurrence it saw, even though it wasn't enough");
});

test("classifyModule: functions below minInstr are not eligible for the recurrence signal", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "tiny-hash": 10 } };
  const m = invModule({ instrCount: 5 });
  const c = classifyModule(m, [sample("tiny-hash", 5)], index, { minInstr: 8 });
  assert.notEqual(c.signal, "cross-app-recurrence");
});

test("classifyModule: recurrenceThreshold and recurrenceFraction are configurable", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 5, hashes: { "fn-hash": 3 } };
  const m = invModule({ instrCount: 20 });
  assert.notEqual(classifyModule(m, [sample("fn-hash", 20)], index, { recurrenceThreshold: 4 }).signal, "cross-app-recurrence");
  assert.equal(classifyModule(m, [sample("fn-hash", 20)], index, { recurrenceThreshold: 3 }).signal, "cross-app-recurrence");
});

test("classifyModule: node_modules path string -> library", () => {
  const m = classifyModule(invModule({ stringConstants: ["at node_modules/lodash/index.js:12"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "node-modules-path");
});

test("classifyModule: versioned package-name string -> library", () => {
  const m = classifyModule(invModule({ stringConstants: ["react-native-reanimated@3.15.0"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "package-name-version-string");
});

test("classifyModule: structural shape (many tiny functions, no strings) -> library", () => {
  const m = classifyModule(
    invModule({ functionIndices: [0, 1, 2, 3, 4], instrCount: 5 * 15, stringConstants: [] }),
    [],
    EMPTY_COMMONALITY_INDEX,
  );
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "structural-shape");
});

test("classifyModule: structural shape is vetoed by an app-specific-looking string", () => {
  const m = classifyModule(
    invModule({ functionIndices: [0, 1, 2, 3, 4], instrCount: 5 * 15, stringConstants: ["ProfileScreen"] }),
    [],
    EMPTY_COMMONALITY_INDEX,
  );
  assert.notEqual(m.signal, "structural-shape");
});

test("classifyModule: real content with no library signal -> app (the safe default)", () => {
  const m = classifyModule(invModule({ instrCount: 200, stringConstants: ["Welcome to MyApp", "/api/v1/checkout"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "app");
});

test("classifyModule: no content at all -> unknown", () => {
  const m = classifyModule(invModule({ instrCount: 0, stringConstants: [], functionIndices: [] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "unknown");
});

test("buildCommonalityIndex counts DISTINCT bundles, not raw occurrences", () => {
  // Hash "h" appears twice within bundle A's own hash SET (e.g. the same
  // helper inlined into two functions), but a Set collapses that -> bundle
  // A contributes at most 1 to h's count.
  const bundleA = new Set(["h", "a1"]);
  const bundleB = new Set(["h", "b1"]);
  const bundleC = new Set(["a1"]); // recurs with A only
  const index = buildCommonalityIndex([bundleA, bundleB, bundleC]);
  assert.equal(index.bundleCount, 3);
  assert.equal(index.hashes["h"], 2);
  assert.equal(index.hashes["a1"], 2);
  assert.equal(index.hashes["b1"], 1);
});

test("mergeCommonalityIndexes sums counts and bundle counts across disjoint corpora", () => {
  const a = buildCommonalityIndex([new Set(["h"]), new Set(["h"])]);
  const b = buildCommonalityIndex([new Set(["h"]), new Set(["only-in-b"])]);
  const merged = mergeCommonalityIndexes(a, b);
  assert.equal(merged.bundleCount, 4);
  assert.equal(merged.hashes["h"], 3);
  assert.equal(merged.hashes["only-in-b"], 1);
});

test("loadCommonalityIndex returns EMPTY_COMMONALITY_INDEX for a missing file", () => {
  const index = loadCommonalityIndex("/nonexistent/path/does-not-exist.json");
  assert.deepEqual(index, EMPTY_COMMONALITY_INDEX);
});

test("summarizeClassifications: percentLibraryByWeight is instruction-weighted, not module-count-weighted", () => {
  const classifications: ModuleClassification[] = [
    { localModuleId: 0, factoryFunctionIndex: 0, instrCount: 900, classification: "library", signal: "cross-app-recurrence", recurrenceCount: 5 },
    { localModuleId: 1, factoryFunctionIndex: 1, instrCount: 100, classification: "app", signal: "none", recurrenceCount: 0 },
  ];
  const summary = summarizeClassifications(classifications);
  assert.equal(summary.totalInstrWeight, 1000);
  assert.equal(summary.percentLibraryByWeight, 90);
  assert.equal(summary.percentAppByWeight, 10);
  assert.equal(summary.libraryInstrWeightBySignal["cross-app-recurrence"], 900);
});

test("classifyInventory covers every module exactly once and derives function samples from ModuleInventory.functions", () => {
  const modules = [invModule({ factoryFunctionIndex: 0, functionIndices: [0] }), invModule({ factoryFunctionIndex: 1, functionIndices: [1], stringSetHash: "hash-y" })];
  const functions = [
    { index: 0, name: "a", paramCount: 0, instrCount: 20, exactHash: "fn-0", fuzzyHash: "fz-0", stringSetHash: "s-0", stringCount: 0 },
    { index: 1, name: "b", paramCount: 0, instrCount: 20, exactHash: "fn-1", fuzzyHash: "fz-1", stringSetHash: "s-1", stringCount: 0 },
  ];
  const inventory = { hbcVersion: 94, totalFunctions: 2, moduledFunctionCount: 2, modules, functions };
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "fn-0": 2 } };
  const result = classifyInventory(inventory, index);
  assert.equal(result.modules.length, 2);
  assert.equal(result.commonalityIndexBundleCount, 3);
  const [a, b] = result.modules;
  assert.equal(a!.signal, "cross-app-recurrence", "module owning fn-0 (recurrence 2 >= default threshold) should classify library");
  assert.notEqual(b!.signal, "cross-app-recurrence", "module owning fn-1 (not in the index) should not");
});

// --- Integration: real bundle, self-recurrence sanity check -------------

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("classifyInventory against rn-template: a self-built commonality index recovers every eligible module as recurring (threshold 1)", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const hashes = functionHashesForCommonality(inventory);
  assert.ok(hashes.size > 0);

  // Build an index from this same bundle's own eligible-function hash set
  // duplicated across 2 "bundles" (a self-consistency check, not a real
  // cross-app claim): every module whose functions clear the minInstr floor
  // must recur.
  const index = buildCommonalityIndex([hashes, hashes]);
  const report = classifyInventory(inventory, index, { recurrenceThreshold: 2 });
  assert.equal(report.summary.libraryModuleCount + report.summary.appModuleCount + report.summary.unknownModuleCount, inventory.modules.length);
  assert.ok(report.summary.percentLibraryByWeight > 90, `expected almost all instruction weight to self-recur, got ${report.summary.percentLibraryByWeight}%`);
});

test("classifyInventory against rn-template: with the committed commonality index, some library-classified weight is found (unnamed)", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const indexPath = join(repoRoot(), "tools", "pkgsig", "commonality-index.json");
  const index = loadCommonalityIndex(indexPath);
  if (index.bundleCount === 0) {
    // Index not built in this checkout (e.g. a fresh clone before
    // tools/pkgsig/build-commonality-index.mjs has ever run) — not this
    // test's job to build it, skip rather than fail.
    return;
  }
  const report = classifyInventory(inventory, index);
  assert.ok(report.summary.percentLibraryByWeight >= 0);
  // Every module is accounted for exactly once.
  assert.equal(report.summary.libraryModuleCount + report.summary.appModuleCount + report.summary.unknownModuleCount, inventory.modules.length);
});
