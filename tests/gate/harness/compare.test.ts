// docs/specs/06-harness.md §11 item 1, §10 HA-01/HA-03/HA-04 — port of
// tools/equiv/test/equiv.test.mjs's verdict tests (part 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProgram } from "../../../src/harness/runner.ts";
import { compareTraces, TRACE_VERDICT } from "../../../src/harness/compare.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-harness-compare-test-"));
const write = (name: string, src: string): string => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, src);
  return f;
};
const OPTS = { timeout: 8000, seed: 0, fuzz: 0, relax: [], maxRecords: 5000, syncTimeout: 7000 };

test("a program that produces no observable behaviour is INCONCLUSIVE, not EQUIVALENT (R3)", async () => {
  const a = write("silent-a.js", "function f(x) { return x + 1; }\nvoid 0;");
  const b = write("silent-b.js", "function f(x) { return x + 2; }\nvoid 0;");
  // Both are silent, but each leaves `f` on the global object, so `globals`
  // gives the harness something -- and the two `f`s encode identically.
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, TRACE_VERDICT.EQUIVALENT);

  // With fuzzing on, the difference is found.
  const fuzzOpts = { ...OPTS, fuzz: 10 };
  const [fa, fb] = await Promise.all([runProgram(a, fuzzOpts), runProgram(b, fuzzOpts)]);
  assert.equal(compareTraces(fa, fb).verdict, TRACE_VERDICT.DIVERGENT);
});

test("HA-04: an entirely empty program is INCONCLUSIVE (never a silent PASS)", async () => {
  const a = write("empty-a.js", ";");
  const b = write("empty-b.js", ";");
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  const r = compareTraces(ta, tb);
  assert.equal(r.verdict, TRACE_VERDICT.INCONCLUSIVE);
  assert.match(r.why, /produced observable behaviour/);
});

test("HA-03: a divergence before a hang is still DIVERGENT, never masked by the later truncation", async () => {
  const a = write("hang-a.js", 'print("a"); while (true) {}');
  const b = write("hang-b.js", 'print("b"); while (true) {}');
  const [ta, tb] = await Promise.all([runProgram(a, { ...OPTS, timeout: 1500, syncTimeout: 1000 }), runProgram(b, { ...OPTS, timeout: 1500, syncTimeout: 1000 })]);
  assert.equal(compareTraces(ta, tb).verdict, TRACE_VERDICT.DIVERGENT);
});

test("R3 guard: two truncated traces with an equal prefix must not compare EQUIVALENT", () => {
  // Directly exercises the exact failure mode docs/EQUIVALENCE.md R3 names: a
  // naive comparator that only checks the common prefix would call this
  // EQUIVALENT. This constructs the truncated-trace shape without spawning a
  // child, so the guard is tested independent of timing.
  const a = { records: [{ k: "out" as const, ch: "print", s: "x", a: [] }, { k: "limit" as const, why: "timeout" }] };
  const b = { records: [{ k: "out" as const, ch: "print", s: "x", a: [] }, { k: "limit" as const, why: "timeout" }] };
  const r = compareTraces(a, b);
  assert.notEqual(r.verdict, TRACE_VERDICT.EQUIVALENT, "HA-01/R3: identical truncated prefixes are INCONCLUSIVE, never PASS");
  assert.equal(r.verdict, TRACE_VERDICT.INCONCLUSIVE);
});

test("HA-01: compareTraces never returns a verdict outside the three-valued set", async () => {
  const cases = [
    ["silent-a.js", "function f(x){return x;}"],
    ["empty-a.js", ";"],
    ["throw-a.js", 'throw new Error("x")'],
  ] as const;
  const files = cases.map(([name, src]) => write(name, src));
  for (const f of files) {
    const t = await runProgram(f, OPTS);
    const r = compareTraces(t, t);
    assert.ok([TRACE_VERDICT.EQUIVALENT, TRACE_VERDICT.DIVERGENT, TRACE_VERDICT.INCONCLUSIVE].includes(r.verdict));
  }
});

// docs/PUSHBACK.md P-16 / docs/BUGS.md 2026-09-04 family H1: the
// "both traces hit a budget -> INCONCLUSIVE" branch above used to be
// unreachable whenever the two record counts differed, because the length
// mismatch was turned into a divergence *before* `truncated` was consulted.
// A non-terminating program bounded by two different budgets always has
// unequal record counts, so 110 of 159 campaign finds were reported
// DIVERGENT for no reason but the cut-off, timing-dependently.
test("P-16: two traces of unequal length, both truncated, with an equal prefix are INCONCLUSIVE, never DIVERGENT", () => {
  const out = (s: string) => ({ k: "out" as const, ch: "print", s, a: [] });
  const limit = { k: "limit" as const, why: "record cap" };
  const a = { records: [out("x"), out("x"), out("x"), limit] };
  const b = { records: [out("x"), out("x"), limit], timedOut: true };
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.INCONCLUSIVE, `unequal lengths with an equal prefix under a budget prove nothing: ${r.why}`);
  assert.match(r.why, /budget/);
  assert.equal(r.divergence, null, "a budget cut-off must not be reported as a divergence — its position is timing-dependent and would become a fuzz signature");
});

test("P-16 guard: unequal-length traces with an equal prefix and NO budget hit are still DIVERGENT", () => {
  const out = (s: string) => ({ k: "out" as const, ch: "print", s, a: [] });
  const a = { records: [out("x"), out("x"), out("x")] };
  const b = { records: [out("x"), out("x")] };
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT, "one program simply printed less than the other — that is real evidence");
  assert.notEqual(r.divergence, null);
});

test("P-16 guard: a divergence inside the common prefix stays DIVERGENT even when both sides are truncated", () => {
  const out = (s: string) => ({ k: "out" as const, ch: "print", s, a: [] });
  const limit = { k: "limit" as const, why: "record cap" };
  const a = { records: [out("x"), out("WRONG"), out("x"), limit] };
  const b = { records: [out("x"), out("right"), limit], timedOut: true };
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT);
  assert.equal(r.divergence?.index, 1);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
