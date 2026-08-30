// docs/specs/06-harness.md §11 item 1 — port of tools/equiv/test/equiv.test.mjs's
// encoder tests (part 1 of the split into per-concern files the spec calls for).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEncoder, renderRecord, isComparable, isEvidence } from "../../../src/harness/trace.ts";
import type { TraceRecord } from "../../../src/harness/trace.ts";

test("encoder distinguishes values that === would confuse", () => {
  const enc = makeEncoder();
  assert.notEqual(enc(0), enc(-0));
  assert.notEqual(enc(1), enc(1n));
  assert.notEqual(enc("1"), enc(1));
  assert.notEqual(enc([1, 2]), enc([1, 2, 3]));
  assert.notEqual(enc({ a: 1, b: 2 }), enc({ b: 2, a: 1 })); // key order is observable
  assert.equal(enc(NaN), "NaN");
});

test("encoder never reads .stack and never invokes getters", () => {
  const enc = makeEncoder();
  let called = false;
  const o = {
    get boom(): number {
      called = true;
      return 1;
    },
  };
  assert.equal(enc(o), "{boom: <accessor>}");
  assert.equal(called, false);
  const e = new TypeError("bad");
  assert.equal(enc(e), 'TypeError("bad")');
});

test("encoder terminates on cyclic and deep structures", () => {
  const enc = makeEncoder();
  const a: { name: string; self?: unknown } = { name: "a" };
  a.self = a;
  assert.match(enc(a), /circular/);
  let deep: { next?: unknown } = {};
  for (let i = 0; i < 100; i++) deep = { next: deep };
  assert.doesNotThrow(() => enc(deep));
});

test("--relax fn-names masks generated names", () => {
  const strict = makeEncoder();
  const relaxed = makeEncoder({ maskFunctionNames: true });
  const f = function original(_a: unknown, _b: unknown): void {};
  const g = function _fun0(_a: unknown, _b: unknown): void {};
  assert.notEqual(strict(f), strict(g));
  assert.equal(relaxed(f), relaxed(g));
});

test("HA-01 support: isComparable drops meta, isEvidence classifies records", () => {
  const meta: TraceRecord = { k: "meta", v: 1, engine: "node", seed: 0 };
  assert.equal(isComparable(meta), false);
  assert.equal(isEvidence({ k: "ret", v: "undefined" }), false);
  assert.equal(isEvidence({ k: "ret", v: "1" }), true);
  assert.equal(isEvidence({ k: "globals", v: "{}" }), false);
  assert.equal(isEvidence({ k: "globals", v: "{a: 1}" }), true);
  assert.equal(isEvidence({ k: "limit", why: "timeout" }), false);
  assert.equal(isEvidence({ k: "out", ch: "print", s: "x", a: [] }), true);
});

test("renderRecord is a total, single-line function of every record kind", () => {
  const kinds: TraceRecord[] = [
    { k: "meta", v: 1, engine: "node", seed: 0 },
    { k: "out", ch: "print", s: "x", a: ["1"] },
    { k: "hostset", o: "window", p: "onload", v: "[fn ~/0]" },
    { k: "call", fn: "f#0", args: ["1"], ret: "2", throws: undefined },
    { k: "call", fn: "f#0", args: ["1"], ret: undefined, throws: "Error: x" },
    { k: "yield", fn: "g#0", i: 0, done: false, v: "1" },
    { k: "settle", id: 0, state: "fulfilled", v: "1" },
    { k: "tick", t: 100 },
    { k: "err", phase: "main", name: "TypeError", message: "x" },
    { k: "unhandled", name: "Error", message: "x" },
    { k: "ret", v: "undefined" },
    { k: "globals", v: "{}" },
    { k: "limit", why: "timeout" },
    { k: "end" },
  ];
  for (const r of kinds) {
    const rendered = renderRecord(r);
    assert.equal(typeof rendered, "string");
    assert.equal(rendered.includes("\n"), false, `renderRecord(${r.k}) must be single-line`);
  }
});
