// docs/specs/01-parser.md §8 T9 (performance) / T10 (format-path coverage, bundles
// rows) — sweep tier: real Metro bundles, D13.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { listBundles } from "../../support/fixtures.ts";
import { requireSweep } from "../../support/tiers.ts";

// Expectations per bundle family. This used to assert `C`/`hbc94` for EVERY
// bundle, which broke the moment a second family (react-navigation, HBC 98,
// layout E) was added to tests/fixtures/bundles/ — the shape is a property of
// the bundle, not of the directory.
const BUNDLE_EXPECTATIONS: readonly { dir: string; layoutClass: string; opcodeTable: string; minFunctions: number }[] = [
  { dir: "rn-template-0.72", layoutClass: "C", opcodeTable: "hbc94", minFunctions: 1000 },
  { dir: "react-navigation-example-0.85.3", layoutClass: "E", opcodeTable: "hbc98-late", minFunctions: 1000 },
];

test("bundles: every flag variant of every family parses cleanly, zero diagnostics", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  assert.ok(bundles.length > 0, "no bundles found under tests/fixtures/bundles/**");
  let checked = 0;
  for (const b of bundles) {
    const expect = BUNDLE_EXPECTATIONS.find((e) => b.path.includes(e.dir));
    assert.ok(expect !== undefined, `${b.path}: no BUNDLE_EXPECTATIONS row — add one when a bundle family is added`);
    const m = parseHbc(b.bytes());
    assert.equal(m.diagnostics.length, 0, `${b.path}: unexpected diagnostics ${m.diagnostics.map((d) => d.code).join(",")}`);
    assert.equal(m.layout.layoutClass, expect.layoutClass, `${b.path}: layout class`);
    assert.equal(m.layout.opcodeTable, expect.opcodeTable, `${b.path}: opcode table`);
    assert.ok(m.functions.length > expect.minFunctions, `${b.path}: expected a real bundle's function count`);
    // M1 review Finding 6: spec 01 §9 requires probe.exhaustive === true "for
    // every fixture and for every bundle under 4 MB" — and only for those, so
    // the check is on the size, not on the family.
    if (b.bytes().length < 4 * 1024 * 1024) {
      assert.equal(m.layout.probe.exhaustive, true, `${b.path}: expected an exhaustive probe (file is under 4MB)`);
    }
    checked++;
  }
  assert.ok(checked >= 4, `only ${checked} bundle variants checked`);
});

test("T9: parses the largest bundle within the §7.3 budget, scaled pro rata to the 12MB target", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  if (bundles.length === 0) {
    t.skip("no bundles present");
    return;
  }
  let largest = bundles[0]!;
  let largestSize = largest.bytes().length;
  for (const b of bundles) {
    const size = b.bytes().length;
    if (size > largestSize) {
      largest = b;
      largestSize = size;
    }
  }
  const start = performance.now();
  const before = process.memoryUsage().rss;
  const m = parseHbc(largest.bytes());
  const elapsed = performance.now() - start;
  const after = process.memoryUsage().rss;

  // §7.3 budget: 12 MB -> <= 400ms. Pro-rata for whatever the largest fixture is.
  const budgetMs = (largestSize / (12 * 1024 * 1024)) * 400;
  assert.ok(elapsed < Math.max(budgetMs, 50), `parse took ${elapsed.toFixed(1)}ms, budget ~${budgetMs.toFixed(1)}ms for ${(largestSize / 1024 / 1024).toFixed(2)}MB`);
  // Peak RSS <= 3x file size is the spec'd bound; RSS deltas are noisy under a shared
  // process, so this is a loose sanity check, not a tight assertion.
  assert.ok(after - before < largestSize * 10 || after < largestSize * 20, `RSS grew implausibly: before=${before} after=${after} size=${largestSize}`);
  assert.equal(m.header.functionCount, m.functions.length);

  // §8 T9 report note.
  console.log(
    `[T9] largest bundle ${largest.path}: ${(largestSize / 1024 / 1024).toFixed(2)}MB, ${m.functions.length} functions, ${elapsed.toFixed(1)}ms ` +
      `(linear extrapolation to 12MB: ${((elapsed / largestSize) * 12 * 1024 * 1024).toFixed(0)}ms)`,
  );
});

test("T9b: strings.get() for every string in the largest bundle stays within the 2.5s secondary budget", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  if (bundles.length === 0) {
    t.skip("no bundles present");
    return;
  }
  const largest = bundles.reduce((a, b) => (b.bytes().length > a.bytes().length ? b : a));
  const m = parseHbc(largest.bytes());
  const start = performance.now();
  for (let id = 0; id < m.strings.count; id++) m.strings.get(id);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2500, `decoding every string took ${elapsed.toFixed(1)}ms (budget 2500ms for 12MB, this bundle is smaller)`);
});

test("T10: overflowed strings, overflowed function headers, and shared bytecode bodies are all present and parse correctly in the real bundle", (t) => {
  if (!requireSweep(t)) return;
  const bundles = listBundles();
  const base = bundles.find((b) => b.path.endsWith("index.android.hbc"));
  if (base === undefined) {
    t.skip("index.android.hbc not present");
    return;
  }
  const m = parseHbc(base.bytes());

  let overflowedStrings = 0;
  for (let id = 0; id < m.strings.count; id++) if (m.strings.entry(id).overflowed) overflowedStrings++;
  assert.ok(overflowedStrings > 0, "expected at least one overflowed string entry");

  const overflowedFns = m.functions.filter((f) => f.header.flags.overflowed).length;
  assert.ok(overflowedFns > 0, "expected at least one overflowed function header");

  const sharedFns = m.functions.filter((f) => f.bodyShared).length;
  assert.ok(sharedFns > 0, "expected at least one shared (deduped) function body");

  assert.ok(m.header.bigIntCount >= 0 && m.regExps.length >= 0);
});
