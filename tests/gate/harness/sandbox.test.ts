// docs/specs/06-harness.md §11 item 1 — port of tools/equiv/test/equiv.test.mjs's
// sandbox/determinism tests (part 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePrng } from "../../../src/harness/sandbox.ts";
import { runProgram } from "../../../src/harness/runner.ts";
import { compareTraces, TRACE_VERDICT } from "../../../src/harness/compare.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-harness-sandbox-test-"));
const write = (name: string, src: string): string => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, src);
  return f;
};
const OPTS = { timeout: 8000, seed: 0, fuzz: 0, relax: [], maxRecords: 5000, syncTimeout: 7000 };

test("prng is deterministic per seed and differs across seeds", () => {
  const a = makePrng(7);
  const b = makePrng(7);
  const c = makePrng(8);
  const seqA = Array.from({ length: 10 }, a);
  const seqB = Array.from({ length: 10 }, b);
  const seqC = Array.from({ length: 10 }, c);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `${v} out of range`);
});

test("Math.random and Date.now are pinned, so a nondeterministic program traces identically", async () => {
  const f = write("nondet.js", `print('r=' + Math.random()); print('t=' + Date.now()); print('d=' + new Date().getTime());`);
  const [x, y] = await Promise.all([runProgram(f, OPTS), runProgram(f, OPTS)]);
  assert.equal(compareTraces(x, y).verdict, TRACE_VERDICT.EQUIVALENT);
  assert.match(JSON.stringify(x.records), /t=1700000000000/);
  assert.match(JSON.stringify(x.records), /d=1700000000000/);
});

test("an infinite loop is killed and reported INCONCLUSIVE, not EQUIVALENT (HA-02)", async () => {
  const f = write("spin.js", 'print("before"); while (true) {}');
  const t = await runProgram(f, { ...OPTS, timeout: 1500, syncTimeout: 1000 });
  assert.ok(t.records.some((r) => r.k === "limit"), "HA-02: a timeout must emit a `limit` record");
  assert.ok(!t.records.some((r) => r.k === "err"), "HA-02: a timeout must never emit an `err` record");
  const r = compareTraces(t, t);
  assert.equal(r.verdict, TRACE_VERDICT.INCONCLUSIVE);
  assert.match(r.why, /budget/);
  assert.ok(t.records.some((rec) => rec.k === "out" && rec.s === "before"), "prefix before the kill must survive");
});

test("thrown errors are compared by name and message, not by stack", async () => {
  const a = write("throw-a.js", 'throw new TypeError("nope");');
  const b = write("throw-b.js", '\n\n\nthrow new TypeError("nope");');
  const c = write("throw-c.js", 'throw new RangeError("nope");');
  const [ta, tb, tc] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS), runProgram(c, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, TRACE_VERDICT.EQUIVALENT);
  assert.equal(compareTraces(ta, tc).verdict, TRACE_VERDICT.DIVERGENT);
});

test("microtask interleaving is captured", async () => {
  const a = write("micro-a.js", `print('sync'); Promise.resolve().then(() => print('m1')).then(() => print('m2')); (async () => { print('afn'); await null; print('after'); })();`);
  const b = write("micro-b.js", `print('sync'); (async () => { print('afn'); await null; print('after'); })(); Promise.resolve().then(() => print('m1')).then(() => print('m2'));`);
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, TRACE_VERDICT.DIVERGENT);
});

test("virtual timers fire in (time, insertion) order without real waiting", async () => {
  const f = write("timers.js", `setTimeout(() => print('late'), 100000); setTimeout(() => print('early'), 1); print('sync');`);
  const started = Date.now();
  const t = await runProgram(f, OPTS);
  assert.ok(Date.now() - started < 4000, "must not actually wait 100 seconds");
  const lines = t.records.filter((r) => r.k === "out").map((r) => (r.k === "out" ? r.s : ""));
  assert.deepEqual(lines, ["sync", "early", "late"]);
});

test("unhandled rejections appear in the trace", async () => {
  const f = write("rej.js", 'Promise.reject(new Error("unheard"));');
  const t = await runProgram(f, OPTS);
  assert.ok(t.records.some((r) => r.k === "unhandled" && r.message === "unheard"));
});

test("host object writes are observable", async () => {
  const f = write("host.js", 'window.onload = function h() {}; document.title = "x";');
  const t = await runProgram(f, OPTS);
  const sets = t.records.filter((r): r is Extract<(typeof t.records)[number], { k: "hostset" }> => r.k === "hostset");
  assert.equal(sets.length, 2);
  assert.equal(sets[0]?.o, "window");
  assert.equal(sets[0]?.p, "onload");
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
