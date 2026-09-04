// tests/gate/tools/minimise-live.test.ts — the live auto-minimiser's two
// pure parts (fuzz fix-wave step 3C, docs/BUGS.md 2026-09-04 family F2).
//
// The live `reproduces` callback itself needs hermesc + a Hermes VM and takes
// tens of seconds per candidate, so it is exercised offline (see the F2 row
// in docs/BUGS.md for the runs). What the gate pins is what silently broke
// before: the find-filename parser (the fuzz *seed* is part of the question a
// find asks — running it under seed 0 asks a different one), and the fact
// that `minimiseAsync` is the same algorithm as `minimise`, not a second one
// that drifts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { minimise, minimiseAsync } from "../../../src/fuzzgen/minimise.ts";
// @ts-expect-error — .mjs tool module, no type declarations by design.
import { parseFindName } from "../../../tools/fuzz/minimise-live.mjs";

test("parseFindName reads the version and seed out of a campaign find's own filename", () => {
  assert.deepEqual(parseFindName("v84-seed783042.js"), { version: 84, seed: 783042 });
  assert.deepEqual(parseFindName("reports/fuzz/finds/v99-seed777080.js"), { version: 99, seed: 777080 });
  assert.deepEqual(parseFindName("/abs/path/v96-seed0.js"), { version: 96, seed: 0 });
  for (const bad of ["candidate.js", "v84-seed.js", "seed783042.js", "v84-783042.js", "v84-seed783042.txt"]) {
    assert.equal(parseFindName(bad), null, bad);
  }
});

const SAMPLE = [
  "let a = 17;",
  "let b = 4;",
  "print(a + b);",
  "print('MARKER');",
  "let c = 250;",
  "for (let i = 0; i < 12; i++) { print(i); }",
  "print(c * 3);",
].join("\n");

/** Reduces to the marker line; the numeric-literal pass can still shrink
 *  whatever survives, so both passes are exercised. */
const reproducesSync = (program: string): boolean => program.includes("print('MARKER');");

test("minimiseAsync reaches the identical reduced program as minimise for a lifted synchronous predicate", async () => {
  const sync = minimise(SAMPLE, reproducesSync);
  const async_ = await minimiseAsync(SAMPLE, (p) => Promise.resolve(reproducesSync(p)));
  assert.equal(async_, sync);
  assert.ok(reproducesSync(async_), "reduced program lost the signature");
  assert.ok(async_.split("\n").length < SAMPLE.split("\n").length, "no progress");
});

test("minimiseAsync is idempotent and awaits its predicate in order", async () => {
  const seen: string[] = [];
  const once = await minimiseAsync(SAMPLE, async (p) => {
    seen.push(p);
    return reproducesSync(p);
  });
  const twice = await minimiseAsync(once, (p) => Promise.resolve(reproducesSync(p)));
  assert.equal(twice, once);
  assert.ok(seen.length > 1, "the predicate was never driven");
  // Every candidate the async reducer proposed was a real program string,
  // never a promise leaked into the join.
  for (const p of seen) assert.equal(typeof p, "string");
});
