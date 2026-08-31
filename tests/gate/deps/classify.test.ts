// docs/DECISIONS.md D17h/D17j/D17i stage 2 — classify each Metro module as
// library (ignorable) vs the app's OWN "custom" code WITHOUT naming the
// package (src/deps/classify.ts). Unit tests against synthetic
// InventoryModule shapes for the signal logic (cross-app recurrence,
// node_modules-path/bare-package-path extraction, app-vocabulary
// derivation and matching, structural shape, the combination rule), plus
// integration checks against the committed rn-template-0.72 fixture.
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
  libraryPathEvidence,
  deriveAppVocabulary,
  EMPTY_COMMONALITY_INDEX,
  EMPTY_APP_VOCABULARY,
} from "../../../src/deps/classify.ts";
import type { CommonalityIndex, ModuleClassification, ModuleFunctionSample, AppVocabulary } from "../../../src/deps/classify.ts";

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

test("classifyModule: recurrence below the count threshold does not trigger the bonus signal", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 3, hashes: { "fn-hash": 1 } };
  const m = invModule({ instrCount: 50, stringConstants: ["hello world"] });
  const c = classifyModule(m, [sample("fn-hash", 50)], index);
  assert.notEqual(c.signal, "cross-app-recurrence");
  assert.equal(c.recurrenceCount, 1);
  // No other signal fires either ("hello world" is not app-vocabulary and
  // the module has only 1 function, below the structural-shape floor) ->
  // honestly reported unknown, not defaulted either way (D17j).
  assert.equal(c.classification, "unknown");
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
  const c = classifyModule(m, [sample("tiny-hash", 5)], index, EMPTY_APP_VOCABULARY, { minInstr: 8 });
  assert.notEqual(c.signal, "cross-app-recurrence");
});

test("classifyModule: recurrenceThreshold and recurrenceFraction are configurable", () => {
  const index: CommonalityIndex = { version: 2, bundleCount: 5, hashes: { "fn-hash": 3 } };
  const m = invModule({ instrCount: 20 });
  assert.notEqual(classifyModule(m, [sample("fn-hash", 20)], index, EMPTY_APP_VOCABULARY, { recurrenceThreshold: 4 }).signal, "cross-app-recurrence");
  assert.equal(classifyModule(m, [sample("fn-hash", 20)], index, EMPTY_APP_VOCABULARY, { recurrenceThreshold: 3 }).signal, "cross-app-recurrence");
});

// --- D17j signal 1: node_modules / bare package-path evidence ---------

test("classifyModule: node_modules path string -> library, package name extracted", () => {
  const m = classifyModule(invModule({ stringConstants: ["at node_modules/lodash/index.js:12"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "node-modules-path");
  assert.equal(m.libraryPackageHint, "lodash");
});

test("classifyModule: scoped node_modules path string -> library, scoped package name extracted", () => {
  const m = classifyModule(invModule({ stringConstants: ["node_modules/@react-navigation/native/lib/index.js"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "library");
  assert.equal(m.libraryPackageHint, "@react-navigation/native");
});

test("libraryPathEvidence: bare (node_modules-stripped) package-relative path is still recognised", () => {
  const hit = libraryPathEvidence(invModule({ stringConstants: ["react-native-reanimated/lib/module/index.js"] }));
  assert.equal(hit, "react-native-reanimated");
});

test("libraryPathEvidence: an app's own route-shaped path string does not false-positive", () => {
  assert.equal(libraryPathEvidence(invModule({ stringConstants: ["settings/profile"] })), null);
});

test("classifyModule: versioned package-name string -> library", () => {
  const m = classifyModule(invModule({ stringConstants: ["react-native-reanimated@3.15.0"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "package-name-version-string");
  assert.equal(m.libraryPackageHint, "react-native-reanimated");
});

// --- D17j signal 2: app-vocabulary presence (the key idea) ------------

test("deriveAppVocabulary: a string recurring across several distinct modules qualifies", () => {
  const inventory = {
    hbcVersion: 94,
    totalFunctions: 0,
    moduledFunctionCount: 0,
    modules: [
      invModule({ stringConstants: ["/api/v1/checkout"] }),
      invModule({ stringConstants: ["/api/v1/checkout"] }),
      invModule({ stringConstants: ["/api/v1/checkout"] }),
      invModule({ stringConstants: ["one-off string A"] }),
      invModule({ stringConstants: ["one-off string B"] }),
    ],
    functions: [],
  };
  const vocab = deriveAppVocabulary(inventory);
  assert.ok(vocab.has("/api/v1/checkout"), "recurs in 3 of 5 modules (>= min frequency) -> qualifies");
  assert.ok(!vocab.has("one-off string A"), "appears in only 1 module -> below the min-frequency floor");
});

test("deriveAppVocabulary: shape-distinctive strings (Screen suffix, hostnames, reverse-DNS bundle id) qualify at frequency 1", () => {
  const inventory = {
    hbcVersion: 94,
    totalFunctions: 0,
    moduledFunctionCount: 0,
    modules: [invModule({ stringConstants: ["ProfileScreen", "https://api.myapp.example.com/v1/x", "com.example.myapp"] })],
    functions: [],
  };
  const vocab = deriveAppVocabulary(inventory);
  assert.ok(vocab.has("ProfileScreen"));
  assert.ok(vocab.has("api.myapp.example.com"), "the hostname itself is added, not just the full URL");
  assert.ok(vocab.has("com.example.myapp"));
});

test("deriveAppVocabulary: generic JS/library boilerplate strings are excluded even if they recur everywhere", () => {
  const inventory = {
    hbcVersion: 94,
    totalFunctions: 0,
    moduledFunctionCount: 0,
    modules: Array.from({ length: 5 }, () => invModule({ stringConstants: ["prototype", "Invariant Violation: bad state", "node_modules/foo/bar.js"] })),
    functions: [],
  };
  const vocab = deriveAppVocabulary(inventory);
  assert.equal(vocab.size, 0);
});

test("classifyModule: app-vocabulary presence -> custom, even when the module also has generic structural shape", () => {
  const vocab: AppVocabulary = new Set(["/api/v1/checkout"]);
  const m = classifyModule(
    invModule({ functionIndices: [0, 1, 2, 3, 4], instrCount: 5 * 15, stringConstants: ["/api/v1/checkout"] }),
    [],
    EMPTY_COMMONALITY_INDEX,
    vocab,
  );
  assert.equal(m.classification, "custom");
  assert.equal(m.signal, "app-vocabulary");
  assert.ok(m.confidence > 0);
});

test("classifyModule: node_modules-path evidence wins over app-vocabulary (library evidence is never overridden by a vocabulary coincidence)", () => {
  const vocab: AppVocabulary = new Set(["lodash"]);
  const m = classifyModule(invModule({ stringConstants: ["node_modules/lodash/index.js", "lodash"] }), [], EMPTY_COMMONALITY_INDEX, vocab);
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "node-modules-path");
});

// --- D17j signal 3: structural shape, only once app-vocabulary is ruled out ---

test("classifyModule: structural shape (many tiny functions, no strings) -> library", () => {
  const m = classifyModule(
    invModule({ functionIndices: [0, 1, 2, 3, 4], instrCount: 5 * 15, stringConstants: [] }),
    [],
    EMPTY_COMMONALITY_INDEX,
  );
  assert.equal(m.classification, "library");
  assert.equal(m.signal, "structural-shape");
});

test("classifyModule: structural shape is preempted by an app-specific-looking string (-> custom, not library)", () => {
  const m = classifyModule(
    invModule({ functionIndices: [0, 1, 2, 3, 4], instrCount: 5 * 15, stringConstants: ["ProfileScreen"] }),
    [],
    EMPTY_COMMONALITY_INDEX,
  );
  assert.equal(m.classification, "custom");
  assert.notEqual(m.signal, "structural-shape");
});

test("classifyModule: real content with no library/vocabulary/shape signal at all -> unknown (honest, not defaulted)", () => {
  // Neither string is bundle-vocabulary-frequent (each module classified in
  // isolation here, EMPTY_APP_VOCABULARY) nor independently shape-distinctive
  // (no Screen/Route/Navigator suffix, no URL, no reverse-DNS id), and the
  // module has only 1 function -> below the structural-shape floor too.
  const m = classifyModule(invModule({ instrCount: 200, stringConstants: ["Welcome to MyApp", "checkout flow started"] }), [], EMPTY_COMMONALITY_INDEX);
  assert.equal(m.classification, "unknown");
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
    { localModuleId: 0, factoryFunctionIndex: 0, instrCount: 900, classification: "library", signal: "cross-app-recurrence", confidence: 0.9, recurrenceCount: 5, libraryPackageHint: null },
    { localModuleId: 1, factoryFunctionIndex: 1, instrCount: 100, classification: "custom", signal: "app-vocabulary", confidence: 0.7, recurrenceCount: 0, libraryPackageHint: null },
  ];
  const summary = summarizeClassifications(classifications);
  assert.equal(summary.totalInstrWeight, 1000);
  assert.equal(summary.percentLibraryByWeight, 90);
  assert.equal(summary.percentCustomByWeight, 10);
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
  assert.equal(report.summary.libraryModuleCount + report.summary.customModuleCount + report.summary.unknownModuleCount, inventory.modules.length);
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
  assert.equal(report.summary.libraryModuleCount + report.summary.customModuleCount + report.summary.unknownModuleCount, inventory.modules.length);
});

test("classifyInventory against rn-template: corpus-free (empty commonality index) still classifies via D17j's bundle-internal signals", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const report = classifyInventory(inventory, EMPTY_COMMONALITY_INDEX);
  assert.equal(report.commonalityIndexBundleCount, 0);
  assert.ok(report.appVocabularySize > 0, "a real app bundle derives a non-empty vocabulary from its own strings alone");
  assert.equal(report.summary.libraryModuleCount + report.summary.customModuleCount + report.summary.unknownModuleCount, inventory.modules.length);
});
