// docs/specs/06-harness.md §7, §11 item 4, §12 — tier runner tests: a small
// subset end-to-end (per §11 item 4), the full gate identity self-proof with
// a stated perf budget (§13's "perf sanity check"), and the mutation
// negative control this milestone's task explicitly asks for: "gate must
// PASS all on identity and DIVERGENT on every control-flow mutation."
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runTier, computeSkippedByDesign, VERDICT } from "../../../src/harness/tiers.ts";
import type { DecompilerFn } from "../../../src/harness/tiers.ts";
import { mutants } from "../../../src/harness/mutate.ts";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc } from "../../support/hermesc.ts";
import { requireOracles, timeScale } from "../../support/tiers.ts";
import { KNOWN_AMBIGUOUS_V98 } from "../../support/known-issues.ts";

// A subset chosen for speed and for being outside every documented gap
// (no known-divergence construct, no v98 layout ambiguity, compiles at every
// fetched version).
const SUBSET = ["01-if-else-chain", "02-while-loop", "04-for-loop-basic"];

test("3-fixture subset, identity decompiler, v94: every oracle PASSes", async (t) => {
  // "every oracle" includes round-trip, which recompiles with hermesc; absent
  // a compiler the verdict is INCONCLUSIVE (D15), which is a missing tool and
  // not a harness failure.
  if (findHermesc(94) === null) {
    if (requireOracles()) throw new Error("hermesc v94 required for the identity oracle set (HBC2JS_REQUIRE_ORACLES=1)");
    t.skip("hermesc v94 not found (run tools/get-hermesc.sh 94) — the round-trip oracle needs it");
    return;
  }
  const report = await runTier({ tier: "gate", only: SUBSET, versions: [94] });
  assert.equal(report.results.length, SUBSET.length);
  for (const r of report.results) {
    assert.equal(r.verdict, VERDICT.PASS, `${r.fixture.name}: ${JSON.stringify(r.oracles)}`);
  }
});

/**
 * Deterministically mutate each fixture's own source.js by dropping one
 * statement (`drop-statement`) — chosen over `mutants()`'s first candidate
 * because that lands on `flip-relational` for this subset, which the
 * selftest's own phase 2 (see selftest.test.ts's survivor log) already
 * measured as a legitimately EQUIVALENT mutant for two of these three
 * fixtures (a boundary flip that happens not to change behaviour here, not a
 * harness blind spot); `negate-condition` was tried too, but it is a latent
 * bug in the ported PoC operator itself — `if (` -> `if (!(` inserts an
 * unbalanced paren, so it NEVER produces syntactically valid JS and
 * `mutants()` always filters it out (verified: it contributes zero mutants
 * to every fixture in this corpus, in both this port and the original
 * `tools/equiv/src/mutate.mjs`, which has the identical logic — a
 * pre-existing PoC defect this port faithfully reproduces per the
 * "behaviour-preserving" instruction, not something introduced by porting;
 * see this milestone's report). `drop-statement` reliably applies to all
 * three fixtures here and is unambiguously a control-flow-relevant mutation
 * (a removed `return`, loop increment, or side-effecting call). This is the
 * negative control the milestone's task asks for: "gate must ... DIVERGENT
 * on every control-flow mutation."
 */
const mutatedDecompiler: DecompilerFn = (input) => {
  if (input.sourceJs === undefined) throw new Error(`no source for ${input.fixtureName}`);
  const ms = mutants(input.sourceJs, 10, 0);
  const dropped = ms.find((m) => m.operator === "drop-statement");
  if (dropped === undefined) throw new Error(`no drop-statement mutant could be generated for ${input.fixtureName} — pick a different fixture for this control`);
  return dropped.text;
};

test("3-fixture subset, single control-flow mutation: every fixture DIVERGES", async () => {
  const report = await runTier({ tier: "gate", only: SUBSET, versions: [94], decompiler: mutatedDecompiler });
  assert.equal(report.results.length, SUBSET.length);
  for (const r of report.results) {
    assert.equal(r.verdict, VERDICT.DIVERGENT, `${r.fixture.name}: mutated candidate should DIVERGE, got ${r.verdict}: ${JSON.stringify(r.oracles)}`);
  }
});

test("computeSkippedByDesign lists 30-async-generator at every version (no hermesc compiles async function*)", () => {
  const skipped = computeSkippedByDesign();
  const forThatFixture = skipped.filter((s) => s.fixture === "30-async-generator");
  assert.ok(forThatFixture.length >= 5, `expected all 5 fetched versions documented as FAILS, got ${JSON.stringify(forThatFixture)}`);
});

test("full gate tier, identity decompiler: DIVERGENT count is zero (perf budget: must finish within 120s, scaled by HBC2JS_TIME_SCALE)", async (t) => {
  const scale = timeScale();
  // Base budgets, at scale=1, on a normal dev machine: 120s wall-clock for
  // the whole tier, 8s per fixture's trace oracle (runOracleLadder's own
  // default). A slow-per-core-but-many-cores box (e.g. `deb`) needs both
  // scaled — CI sets HBC2JS_TIME_SCALE=2.5 for exactly this reason; see
  // docs/STATUS.md's CI line.
  const budgetMs = 120000 * scale;
  const traceTimeoutMs = 8000 * scale;
  const started = Date.now();
  const report = await runTier({ tier: "gate", budgets: { timeoutMs: traceTimeoutMs } });
  const elapsed = Date.now() - started;
  await t.test("timing", () => {
    console.log(`full gate identity run: ${elapsed}ms for ${report.results.length} checks (budget ${budgetMs}ms)`);
  });
  assert.ok(elapsed < budgetMs, `gate identity run took ${elapsed}ms, over the ${budgetMs}ms budget`);

  const divergent = report.results.filter((r) => r.verdict === VERDICT.DIVERGENT);
  assert.equal(divergent.length, 0, `identity must never DIVERGE: ${JSON.stringify(divergent.map((r) => r.fixture.name))}`);

  // Every ERROR must be the one documented, out-of-ownership cause this
  // milestone inherited (src/parse/**'s v98 opcode-table ambiguity — see
  // tests/support/known-issues.ts's KNOWN_AMBIGUOUS_V98 list, and this
  // milestone's report). Any other ERROR is a real harness bug.
  // (The list lives in tests/support/known-issues.ts so a fixture added there
  // — 64-computed-method-names, 2026-09-05 — is attributed here too.)
  const errors = report.results.filter((r) => r.verdict === VERDICT.ERROR);
  const unexplained = errors.filter((r) => !KNOWN_AMBIGUOUS_V98.some((name) => r.fixture.name === name || r.fixture.name === `${name}.min`));
  assert.equal(unexplained.length, 0, `unexplained ERROR(s), not attributable to the known v98 layout ambiguity: ${JSON.stringify(unexplained.map((r) => ({ name: r.fixture.name, oracles: r.oracles })))}`);

  console.log(`gate summary: ${JSON.stringify(report.summary)}, ${report.results.reduce((n, r) => n + r.caveats.length, 0)} PASS-with-caveat, ${report.skippedByDesign.length} skipped-by-design`);
});

test("root sanity: the fixture corpus this test suite depends on actually exists", () => {
  const constructsDir = path.join(repoRoot(), "tests", "fixtures", "constructs");
  assert.ok(fs.existsSync(constructsDir));
  assert.ok(fs.readdirSync(constructsDir).length > 40);
});
