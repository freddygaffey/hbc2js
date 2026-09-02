// tests/gate/harness/compare-message-mask.test.ts — docs/BUGS.md 2026-09-02
// ("oracle message-text masking" row): `compareTraces` used to exact-text
// compare a thrown error's `.message`, so a candidate whose naming passes
// (fn-naming/var-naming/reg-split) synthesised different identifiers than
// the source reported a false DIVERGENT even when the error's constructor,
// thrown-vs-not-thrown shape, and every other observable value matched.
// This proves the fix: identifier-shaped tokens inside an `err`/`unhandled`
// record's message are masked before comparison, a masked-only match is
// surfaced distinctly via `maskedMatches` (never a silent pass), and a
// genuinely different constructor / thrown-vs-not-thrown / non-identifier
// message difference still reports DIVERGENT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTraces, TRACE_VERDICT } from "../../../src/harness/compare.ts";
import type { TraceRecord } from "../../../src/harness/trace.ts";

const trace = (records: readonly TraceRecord[]) => ({ records });

test("thrown TypeError messages differing only in identifier text: EQUIVALENT via masked-match, not a silent pass", () => {
  const a = trace([{ k: "err", phase: "main", name: "TypeError", message: "items.map is not a function" }]);
  const b = trace([{ k: "err", phase: "main", name: "TypeError", message: "list.filter is not a function" }]);
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.EQUIVALENT, r.why);
  assert.equal(r.maskedMatches.length, 1, "must be surfaced distinctly, never silently folded away");
  assert.match(r.maskedMatches[0]!, /identifier-masked match/);
});

test("thrown-error masking does not affect the constructor name: a different Error type still DIVERGENT", () => {
  const a = trace([{ k: "err", phase: "main", name: "TypeError", message: "items.map is not a function" }]);
  const b = trace([{ k: "err", phase: "main", name: "RangeError", message: "list.filter is not a function" }]);
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT);
  assert.equal(r.maskedMatches.length, 0);
});

test("thrown-vs-not-thrown is still compared exactly: masking never manufactures a match out of a missing throw", () => {
  const out = { k: "out" as const, ch: "print", s: "before", a: [] as readonly string[] };
  const a = trace([out, { k: "err", phase: "main", name: "TypeError", message: "items.map is not a function" }]);
  const b = trace([out]);
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT);
});

test("a non-identifier structural difference in the message still DIVERGENT (mask is conservative, not a full mask)", () => {
  const a = trace([{ k: "err", phase: "main", name: "TypeError", message: "Cannot read properties of undefined (reading 'x')" }]);
  const b = trace([{ k: "err", phase: "main", name: "TypeError", message: "Cannot read properties of null (reading 'x')" }]);
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT, "undefined vs null is a real semantic difference, not an identifier-naming artefact");
  assert.equal(r.maskedMatches.length, 0);
});

test("an ordinary print-record divergence (no error involved at all) is unaffected: masking is scoped to err/unhandled only", () => {
  const a = trace([{ k: "out", ch: "print", s: "hello", a: [] }]);
  const b = trace([{ k: "out", ch: "print", s: "goodbye", a: [] }]);
  const r = compareTraces(a, b);
  assert.equal(r.verdict, TRACE_VERDICT.DIVERGENT);
  assert.equal(r.maskedMatches.length, 0);
});
