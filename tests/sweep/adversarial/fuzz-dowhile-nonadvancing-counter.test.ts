// QUEUE 11 / docs/BUGS.md 2026-09-05 fix-wave-4 row (fuzz family F2 residual)
// -- regression cover for the CONSTRUCTS of construct-fuzzer find
// `reports/fuzz/finds/v99-seed777142.js`, which itself can never be a fixture
// because it is non-terminating by construction (see that fixture's
// `source.js` header and `docs/reports/2026-09-05-finds-reclassified-post-fixwave4.md`,
// "No fixtures, and why").
//
// Lives under `tests/sweep/adversarial/`, not `tests/gate/**`, for exactly
// the reason spelled out at the top of `spread-non-iterable-message.test.ts`:
// `report.test.ts`'s D22a rule test forbids a gate file that both imports the
// tier runner and names `fixtures/adversarial`, because the per-push gate must
// never depend on decompiling deliberately-adversarial code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, hbc2jsDecompiler, VERDICT } from "../../../src/harness/tiers.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { requireSweep } from "../../support/tiers.ts";

const FIXTURE = "48-fuzz-dowhile-nonadvancing-counter";

test("QUEUE-11/F2-residual: 48-fuzz-dowhile-nonadvancing-counter decompiles to a candidate matching the real Hermes VM at every version with a VM on this machine", async (t) => {
  if (!requireSweep(t)) return;

  const versionsWithVm = [94, 96, 99].filter((v) => findHermesVm(v) !== null);
  if (versionsWithVm.length === 0) {
    t.skip("no Hermes VM for v94/v96/v99 on this machine (see docs/TOOLCHAIN.md \"Hermes VM (source build)\")");
    return;
  }

  const report = await runTier({ tier: "adversarial", only: [FIXTURE], versions: versionsWithVm, decompiler: hbc2jsDecompiler });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS);
  assert.deepEqual(
    bad.map((r) => `v${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`).join(" ")}`),
    [],
  );
  assert.equal(report.results.length, versionsWithVm.length);
});
