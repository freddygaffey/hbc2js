// docs/BUGS.md `iterable-wording` — dedicated regression for
// `tests/fixtures/adversarial/47-spread-non-iterable-message`.
//
// This fixture lives in `adversarial/`, not `constructs/`: its whole point is
// that the ORIGINAL source.js, run under Node, throws different TypeError
// text than the real Hermes VM does for the same non-iterable spread/
// destructure (Node embeds source-expression text; Hermes does not describe
// the value at all — see `src/runtime/helpers.ts`'s `__hbc_notIterable`).
// That is exactly a `constructs/`-directory-scanning gate test's blind spot:
// `tests/gate/harness/tiers.test.ts`'s "full gate tier, identity decompiler"
// test uses the *unmodified source* as its own "candidate", which therefore
// always disagrees with the VM here by construction, and `constructs/`
// fixtures need no per-fixture opt-out for that (unlike `adversarial/`,
// `constructs/` has no equivalent to `reference-policy.ts`'s
// `KNOWN_DIVERGENT_FIXTURES`-driven caveat wired into a test outside
// `tests/gate/harness/*`/`tests/sweep/*`, both out of scope for this task —
// see docs/PUSHBACK.md). This file instead drives the REAL decompiler
// directly (`hbc2jsDecompiler`, exactly `hbc2js gate`'s own decompiler) and
// asserts PASS, which is the actual claim this bug fix makes: the decompiled
// candidate's thrown-error text now matches the real Hermes VM's, not that
// the original hand-written source happens to as well.
//
// Lives under `tests/sweep/adversarial/`, not `tests/gate/**` (2026-09-05,
// CI red-run fix): `tests/sweep/adversarial/report.test.ts`'s own
// "gate tier never decompiles tests/fixtures/adversarial/** for pass/fail"
// rule test (D22a) flags exactly this pattern — a gate file importing the
// harness's tier runner AND mentioning `fixtures/adversarial` — because the
// invariant that rule protects is "the fast, must-pass-every-push gate never
// depends on decompiling deliberately-adversarial code," not "no test
// anywhere may assert pass/fail on an adversarial fixture." Moving this file
// to `tests/sweep/` (alongside `report.test.ts`, the corpus-wide non-gating
// report) keeps the regression assertion real (unlike `report.test.ts`, this
// file DOES fail on a real regression) while satisfying the rule: `npm test`
// (the gate CI runs on every push) no longer touches it at all; it runs
// under `npm run test:sweep`/`test:all`, which `sweep.yml` also runs on
// every push to main, so the regression protection is not lost — just moved
// off the tight per-push gate, matching this bug's own adversarial-tier home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, hbc2jsDecompiler, VERDICT } from "../../../src/harness/tiers.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { requireSweep } from "../../support/tiers.ts";

const FIXTURE = "47-spread-non-iterable-message";

test("review-M4-H3/iterable-wording: 47-spread-non-iterable-message decompiles to a candidate matching the real Hermes VM's TypeError text at every version with a VM on this machine", async (t) => {
  if (!requireSweep(t)) return;

  // Same convention as `tests/support/hermesvm.ts`'s `requireHermesVm`: the
  // source-built Hermes VM is never provisioned by any CI workflow, so a
  // missing VM is ALWAYS a skip/INCONCLUSIVE, even under
  // HBC2JS_REQUIRE_ORACLES=1 — this is not a provisionable oracle the way
  // hermesc is.
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
