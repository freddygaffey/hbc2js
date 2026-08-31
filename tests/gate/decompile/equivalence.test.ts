// review-M4-H1 — the M4 acceptance run, in the GATE.
//
// docs/specs/05-emitter.md §11 T2. This used to live in `tests/sweep/`, which
// `npm test` does not execute, and `hbc2js gate` scored the *identity*
// decompiler — so the per-commit gate contained no execution-equivalence check
// of the decompiler at all.
//
// npm-test-gate-speed (2026-08-31): this used to run the full 5-version
// matrix (84/94/96/98/99) on every `npm test`, ~500+ fixture checks, which
// made the gate exceed 3 minutes (worse: `src/harness/tiers.ts`'s
// `KNOWN_HANGS` two entries were, until this task, silently making some runs
// take 10+ minutes or never finish — see that constant's own comment). It now
// runs every construct fixture (both the plain and `.min` variant) plus
// `hermes-dec-sample`, but at only GATE_VERSIONS below — a representative
// subset, not all five — and the full matrix moved to
// `tests/sweep/decompile/sweep.test.ts`'s "T2-full" test (`npm run
// test:sweep`, not gated on every commit). See docs/TESTING.md's "Gate vs
// sweep: which HBC versions" for why 94+99 is representative rather than
// arbitrary, and reference-policy.ts's `KNOWN_DIVERGENT_FIXTURES` for why
// both are independently confirmed against a real Hermes VM (84/89/94/99 are
// measured; 96/98 are not).
//
// The oracle set is `syntax + trace`, `runTier`'s default for a real
// decompiler; `roundtrip` and `fuzz` are excluded for the reasons recorded in
// docs/STATUS.md's M4 section and in `defaultOraclesForTier`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

/** docs/HBC-FORMAT.md's two axes of format variation: v98 has two header
 *  layouts/tables and v99 has two opcode tables. v94 (old layout, old opcode
 *  table) and v99 (new layout, and itself probes between its two opcode
 *  tables per fixture) together exercise both axes without needing all five
 *  versions on every commit — the axis v98 alone would represent (its
 *  "two layouts/tables") is the same layout split v94-vs-99 already crosses,
 *  and v98's own ambiguity is a *parser* concern (`KNOWN_AMBIGUOUS_V98`,
 *  `--force-v98-table`), not a distinct execution-semantics family the
 *  equivalence oracle would catch differently. 84 and 96 are pure
 *  interpolations between the two and add coverage breadth, not a new axis;
 *  they still run in the sweep's full matrix (see above), just not on every
 *  `npm test`. */
const GATE_VERSIONS: readonly number[] = [94, 99];

/** The count for `GATE_VERSIONS` on this corpus (checked by "not fewer than"
 *  — new fixtures only raise it). A drop means fixtures went missing. */
const MIN_CHECKS = 200;

test("T2 (review-M4-H1): every gate fixture is PASS under the real decompiler, at the representative gate versions", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, versions: GATE_VERSIONS });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS);
  assert.deepEqual(
    bad.map((r) => `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`).join(" ")}`),
    [],
  );
  assert.equal(report.summary.divergent, 0);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.inconclusive, 0);
  assert.ok(report.summary.pass >= MIN_CHECKS, `only ${report.summary.pass} checks ran (expected at least ${MIN_CHECKS})`);
  console.log(`gate (real decompiler, v${GATE_VERSIONS.join("+v")}): ${JSON.stringify(report.summary)}, ${report.skippedByDesign.length} skipped-by-design`);
});
