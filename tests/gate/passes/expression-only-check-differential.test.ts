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
import { _setExpressionOnlyCheckDiffProbeForTests } from "../../../src/passes/ast.ts";
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
