// review-M4-H1 — the M4 acceptance run, in the GATE.
//
// docs/specs/05-emitter.md §11 T2. This used to live in `tests/sweep/`, which
// `npm test` does not execute, and `hbc2js gate` scored the *identity*
// decompiler — so the per-commit gate contained no execution-equivalence check
// of the decompiler at all. It costs ~26 s with the worker pool, which is
// inside the budget, so it runs on every `npm test` now.
//
// The oracle set is `syntax + trace`, `runTier`'s default for a real
// decompiler; `roundtrip` and `fuzz` are excluded for the reasons recorded in
// docs/STATUS.md's M4 section and in `defaultOraclesForTier`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";

/** The count `docs/STATUS.md` publishes. A drop means fixtures went missing. */
const MIN_CHECKS = 495;

test("T2 (review-M4-H1): every gate fixture is PASS under the real decompiler", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS);
  assert.deepEqual(
    bad.map((r) => `${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`).join(" ")}`),
    [],
  );
  assert.equal(report.summary.divergent, 0);
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.inconclusive, 0);
  assert.ok(report.summary.pass >= MIN_CHECKS, `only ${report.summary.pass} checks ran (expected at least ${MIN_CHECKS})`);
  console.log(`gate (real decompiler): ${JSON.stringify(report.summary)}, ${report.skippedByDesign.length} skipped-by-design`);
});
