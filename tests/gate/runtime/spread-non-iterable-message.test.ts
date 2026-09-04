// docs/BUGS.md `iterable-wording` — dedicated gate regression for
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
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTier, hbc2jsDecompiler, VERDICT } from "../../../src/harness/tiers.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";

const FIXTURE = "47-spread-non-iterable-message";

test("review-M4-H3/iterable-wording: 47-spread-non-iterable-message decompiles to a candidate matching the real Hermes VM's TypeError text at every version with a VM on this machine", async () => {
  const versionsWithVm = [94, 96, 99].filter((v) => findHermesVm(v) !== null);
  assert.ok(versionsWithVm.length > 0, "expected at least one of v94/v96/v99 to have a Hermes VM on this machine (tools/hermes-vm or tools/hermesc/v96/hermes)");

  const report = await runTier({ tier: "adversarial", only: [FIXTURE], versions: versionsWithVm, decompiler: hbc2jsDecompiler });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS);
  assert.deepEqual(
    bad.map((r) => `v${r.fixture.name}: ${r.oracles.map((o) => `${o.oracle}=${o.verdict}${o.detail !== undefined ? ` (${o.detail})` : ""}`).join(" ")}`),
    [],
  );
  assert.equal(report.results.length, versionsWithVm.length);
});
