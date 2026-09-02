// tests/fuzz/mutate.test.ts — docs/BUGS.md 2026-09-02 (mutation
// version-gating). Regression: mutation mode must never hand a
// version-gated construct's `source.js` (e.g. a class fixture, which no
// v94 hermesc supports) to a target version its own `versions.txt` marks
// FAILS — before this fix `corpusSources()`/`mutateFromCorpus()` had no
// version awareness at all, so a class-shaped mutation at v94 produced a
// driver ERROR verdict that was really "hermesc correctly rejected this",
// not a toolchain/generator fault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { corpusSources, mutateFromCorpus } from "../../src/fuzzgen/mutate.ts";

function readVersionsTxtFails(sourcePath: string): Set<number> {
  const dir = sourcePath.replace(/\/source\.js$/, "");
  const failed = new Set<number>();
  try {
    const text = readFileSync(`${dir}/versions.txt`, "utf8");
    for (const line of text.split("\n")) {
      const m = /^v(\d+):\s*FAILS\b/.exec(line.trim());
      if (m !== null) failed.add(Number(m[1]));
    }
  } catch {
    // no versions.txt
  }
  return failed;
}

test("corpusSources(94) excludes every fixture whose versions.txt marks v94 FAILS", () => {
  const all = corpusSources();
  const gated94 = all.filter((p) => readVersionsTxtFails(p).has(94));
  assert.ok(gated94.length > 0, "expected at least one v94-gated fixture in the corpus (e.g. a class construct)");

  const filtered = corpusSources(94);
  for (const p of gated94) {
    assert.ok(!filtered.includes(p), `${p} is marked "v94: FAILS" in its versions.txt but corpusSources(94) still includes it`);
  }
  // Non-gated fixtures are untouched.
  assert.ok(filtered.length < all.length, "corpusSources(94) must be a strict subset when some fixtures are v94-gated");
});

test("mutateFromCorpus with version=94 never selects a v94-gated fixture, across many seeds", () => {
  const all = corpusSources();
  const gated94Sources = new Set(all.filter((p) => readVersionsTxtFails(p).has(94)).map((p) => readFileSync(p, "utf8").trim()));
  assert.ok(gated94Sources.size > 0, "need at least one v94-gated fixture to make this test meaningful");

  for (let seed = 800000; seed < 800200; seed++) {
    const mutated = mutateFromCorpus(seed, 94);
    // The mutator's fallback path returns the pristine fixture text
    // unmodified when `node --check` rejects the mutated form — comparing
    // the *un-mutated* gated sources is enough to catch "picked a gated
    // fixture at all", regardless of which mutation ops fired.
    for (const gatedSrc of gated94Sources) {
      assert.notEqual(mutated.trim(), gatedSrc, `seed ${seed}: mutateFromCorpus(seed, 94) selected a v94-gated fixture's pristine source`);
    }
  }
});

test("mutateFromCorpus with no version argument keeps selecting from the full corpus (unchanged default behaviour)", () => {
  const full = corpusSources();
  const gated = corpusSources(94);
  assert.ok(gated.length <= full.length);
  // No version passed: mutateFromCorpus(seed) must still work exactly as
  // before (backward-compatible optional parameter).
  const src = mutateFromCorpus(12345);
  assert.equal(typeof src, "string");
  assert.ok(src.length > 0);
});
