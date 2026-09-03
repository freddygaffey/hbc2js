// docs/specs/09-fuzzing.md §2.3 "Sampling, rotation, diversity (never the
// full matrix)": tools/appgen/campaign.mjs's `selectSample` is a pure
// function of (store, opts), so its determinism, quota, and coverage
// properties are testable gate-fast, with NO builds (dry-run only). Actual
// campaign builds are sweep-gated (tests/sweep/appgen/build-axes.test.ts)
// exactly like build.mjs's own real-triple test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectSample, allCells, cellFingerprint, CAMPAIGN_AXES, type Cell } from "../../tools/appgen/campaign.mjs";

test("campaign selectSample: deterministic given the same store and rngSeed", () => {
  const store = [
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "1", evicted: false },
  ];
  const a = selectSample(store, { sampleSize: 3, rngSeed: 7 });
  const b = selectSample(store, { sampleSize: 3, rngSeed: 7 });
  assert.deepEqual(a, b, "same store + rngSeed must yield the same selection");
});

test("campaign selectSample: never assigns a seed already present in the store", () => {
  const store = [
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "5", evicted: false },
    { hbcVersion: 98, bundler: "metro-plain", obfuscation: "off", seed: "12", evicted: false },
  ];
  const { selection } = selectSample(store, { sampleSize: 5, rngSeed: 99 });
  const usedBefore = new Set(store.map((e) => e.seed));
  for (const c of selection) assert.ok(!usedBefore.has(String(c.seed)), "seed must not reuse a stored seed");
  // Also no duplicate seeds within one run's selection.
  assert.equal(new Set(selection.map((c) => c.seed)).size, selection.length);
});

test("campaign selectSample: below the >=5-entry quota threshold (spec §2.3 item 2), no axis is excluded", () => {
  // 4 entries all sharing one axis value is still under the 5-entry floor,
  // so quota must not yet suppress that value.
  const store = [
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "1", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "2", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "3", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "4", evicted: false },
  ];
  const { selection, quotaSaturated } = selectSample(store, { sampleSize: 1, rngSeed: 1 });
  assert.equal(quotaSaturated, false);
  assert.ok(selection.length === 1);
});

test("campaign selectSample: coverage pressure prefers the least-covered cell (spec §2.3 item 3)", () => {
  // Every cell except one HBC-98 cell already has a live triple; the least-
  // covered cell (count 0) must be selected first.
  const store = allCells()
    .filter((c: Cell) => !(c.hbcVersion === 98 && c.bundler === "metro-ram" && c.obfuscation === false))
    .map((c: Cell, i: number) => ({
      hbcVersion: c.hbcVersion,
      bundler: c.bundler,
      obfuscation: c.obfuscation ? "metro-minify" : "off",
      seed: String(1000 + i),
      evicted: false,
    }));
  const { selection } = selectSample(store, { sampleSize: 1, rngSeed: 3 });
  assert.ok(selection[0]);
  assert.equal(selection[0]!.cellFingerprint, cellFingerprint({ hbcVersion: 98, bundler: "metro-ram", obfuscation: false }));
});

test("campaign selectSample: axis quota (spec §2.3 item 2) excludes a value once it is >= 40% of >=5 live triples", () => {
  // 4/5 live entries pin hbcVersion 96 (80%, over the 40% cap) -- selection
  // must not propose another hbcVersion:96 cell while an under-quota
  // alternative (hbcVersion 98) exists.
  const store = [
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "1", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "2", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "3", evicted: false },
    { hbcVersion: 96, bundler: "metro-plain", obfuscation: "off", seed: "4", evicted: false },
    { hbcVersion: 98, bundler: "metro-plain", obfuscation: "off", seed: "5", evicted: false },
  ];
  const { selection } = selectSample(store, { sampleSize: 1, rngSeed: 4 });
  assert.ok(selection[0]);
  assert.equal(selection[0]!.rnPin.hbcVersion, 98, "quota-saturated hbcVersion 96 must not be re-selected");
});

test("campaign CAMPAIGN_AXES / allCells: covers exactly the axes this increment implements", () => {
  assert.deepEqual(new Set(CAMPAIGN_AXES.hbcVersion), new Set([96, 98]));
  assert.deepEqual(CAMPAIGN_AXES.bundler, ["metro-plain", "metro-ram"]);
  assert.deepEqual(CAMPAIGN_AXES.obfuscation, [false, true]);
  assert.equal(allCells().length, 2 * 2 * 2);
});
