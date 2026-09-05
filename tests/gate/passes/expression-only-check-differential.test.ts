// QUEUE "Perf part 3" (docs/reports/2026-09-03-architecture-sweep.md finding
// 1): `expressionOnlyCheck`'s read-before-def half was made incremental
// (`src/passes/ast.ts`'s `incrementalReadBeforeDef`, position-keyed instead
// of `defUse(after)`'s whole-list walk per applied site). This is the
// behaviour-preservation proof for that change: `src/passes/ast.ts` keeps
// the pre-incrementalisation algorithm as a private reference
// (`readBeforeDefBruteForceReference`, never on the hot path) and exposes a
// test-only probe (`_setExpressionOnlyCheckDiffProbeForTests`) that
// `expressionOnlyCheck` calls with *both* verdicts on every real invocation.
// This test decompiles the whole construct-fixture corpus — every fixture,
// every bytecode version present — through the real pipeline with passes
// on, which drives every rung that calls `expressionOnlyCheck`
// (`expr-rebuild`, `global-access`, …) at every one of their real applied
// sites, and asserts the old and new algorithms never once disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { _setExpressionOnlyCheckDiffProbeForTests, expressionOnlyCheck } from "../../../src/passes/ast.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import { decompile } from "../../../src/decompile.ts";
import { listFixtures } from "../../support/fixtures.ts";

test("expressionOnlyCheck: incremental read-before-def matches the brute-force reference on the whole construct-fixture corpus", () => {
  let calls = 0;
  let sitesWithChecks = 0;
  const mismatches: string[] = [];
  _setExpressionOnlyCheckDiffProbeForTests((_before, _after, oldVerdict, newVerdict) => {
    calls++;
    // Accept/reject equivalence, not exact-name equivalence: when more than
    // one register is simultaneously violating, old (a fresh `Map` rescan)
    // and new (a `Set` carried forward incrementally) may legitimately name
    // a *different* offender first — `expressionOnlyCheck`'s contract
    // (§4.3) and this rung's own goal are both about `CheckResult.ok`, not
    // about which name ends up in the diagnostic string.
    if ((oldVerdict === null) !== (newVerdict === null)) mismatches.push(`old=${JSON.stringify(oldVerdict)} new=${JSON.stringify(newVerdict)}`);
  });
  try {
    for (const fixture of listFixtures({ group: "constructs" })) {
      for (const binary of fixture.binaries) {
        if (binary.variant !== "") continue; // base binaries only: the differential is about the algorithm, not corpus breadth
        let bytes: Uint8Array;
        try {
          bytes = binary.bytes();
        } catch {
          continue;
        }
        try {
          decompile(bytes, {});
          sitesWithChecks++;
        } catch {
          // A fixture that fails to decompile for unrelated reasons (layout
          // ambiguity, an unrelated known issue, …) still ran whatever
          // passes got as far as `expressionOnlyCheck` before the failure —
          // the probe already recorded those. Nothing to do here.
        }
      }
    }
  } finally {
    _setExpressionOnlyCheckDiffProbeForTests(null);
  }
  assert.ok(sitesWithChecks > 50, `expected the construct corpus to yield 50+ decompiled binaries, got ${sitesWithChecks}`);
  assert.ok(calls > 0, "expected expressionOnlyCheck to be called at least once across the corpus");
  assert.deepEqual(mismatches, [], `${mismatches.length}/${calls} expressionOnlyCheck calls disagreed between old and new algorithms`);
});

// ---------------------------------------------------------------------------
// The prefix/middle first-def hazard (docs/BUGS.md's superlinear-pass row,
// part 3 "why no test yet" cell): the corpus test above proves the
// incremental check agrees with the brute-force one on every site the real
// pipeline actually produces, but it cannot *aim* at the one shape a naive
// memo gets wrong, because the split between "frozen prefix" and "changed
// middle" is recomputed per call and a register's own first def can cross
// that line from one splice to the next. This test drives
// `expressionOnlyCheck` directly along a lineage built to cross it in both
// directions, with the differential probe on, and asserts the verdicts
// themselves — not just that the two algorithms agree.
//
// A naive memo ("cache the violating-name set by list identity; recompute
// only the names appearing in the new middle") passes step 1 and then gets
// step 2 wrong in the unsound direction: the splice *deletes* the only
// statement that defined `r0`, so `r0` appears nowhere in the new middle,
// its status is carried forward unchanged as "fine", and a rewrite that now
// reads `r0` before its first def is accepted. Step 3 is the same hazard in
// the merely-wrong direction (a sticky violating set would keep `r0`
// flagged forever after the def comes back). The shipped implementation
// recomputes every name touched by *either* side of the splice
// (`namesTouching(before.slice(head, tailBefore))` in `src/passes/ast.ts`),
// which is what makes both steps come out right.
const store = (reg: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(reg), value } });

test("expressionOnlyCheck: a register whose first def crosses the frozen-prefix/changed-middle line is re-judged, not carried forward", () => {
  const probe: (readonly [string | null, string | null])[] = [];
  _setExpressionOnlyCheckDiffProbeForTests((_b, _a, oldVerdict, newVerdict) => {
    probe.push([oldVerdict, newVerdict]);
  });
  try {
    // Every statement below is effect-free except `sink(r1)`, which is never
    // touched: the effect-sequence half of the check therefore always passes
    // and every verdict here is decided by the read-before-def half alone.
    const defR0 = store("r0", lit("5"));
    const readR0 = store("r1", id("r0"));
    const redefR0 = store("r0", lit("6"));
    const sink: Stmt = { k: "expr", expr: { k: "call", callee: id("sink"), args: [id("r1")] } };
    const tail = store("r2", lit("7"));

    // Step 1: touch only the last statement. `defR0` .. `sink` become the
    // frozen, cached prefix; `r0`'s first def lives inside it.
    const l0: readonly Stmt[] = [defR0, readR0, redefR0, sink, tail];
    // One clone object, reused by every later step: reference identity is
    // exactly what the prefix/suffix split keys off, so a *fresh* clone per
    // step would make the whole list "changed" and hide the hazard behind a
    // full recompute.
    const tailClone: Stmt = { ...tail };
    const l1: readonly Stmt[] = [defR0, readR0, redefR0, sink, tailClone];
    assert.deepEqual(expressionOnlyCheck(l0, l1), { ok: true }, "step 1: cloning one trailing statement changes nothing");

    // Step 2: delete `defR0` — index 0, so the previously frozen prefix is
    // now inside the changed region, and `r0`'s surviving read (`readR0`)
    // precedes its surviving def (`redefR0`).
    const l2: readonly Stmt[] = [readR0, redefR0, sink, tailClone];
    const afterDelete = expressionOnlyCheck(l1, l2);
    assert.equal(afterDelete.ok, false, "step 2: deleting r0's first def makes r0 read-before-def; a memo that carries r0's old status forward accepts this unsoundly");
    assert.match(afterDelete.ok === false ? afterDelete.reason : "", /^r0 is read before its first def/);

    // Step 3: put a def of `r0` back at the front — the first def crosses
    // the line the other way and the list is legal again.
    const l3: readonly Stmt[] = [{ ...defR0 }, readR0, redefR0, sink, tailClone];
    assert.deepEqual(expressionOnlyCheck(l2, l3), { ok: true }, "step 3: restoring a def ahead of the read clears the violation; a sticky violating set would keep r0 flagged");

    assert.equal(probe.length, 3, "the probe saw every call");
    for (const [oldVerdict, newVerdict] of probe) assert.equal(newVerdict, oldVerdict, "incremental and brute-force verdicts agree at every step");
    assert.deepEqual(
      probe.map(([, v]) => v),
      [null, "r0", null],
      "and the brute-force reference itself judges the three steps ok / violating / ok",
    );
  } finally {
    _setExpressionOnlyCheckDiffProbeForTests(null);
  }
});
