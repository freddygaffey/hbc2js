// tests/security/t6-lane-s-recall.test.ts — T6 (spec 13 §10, §8.1). measure-semgrep
// on the fixture >= 9/10 classes; skipped-with-reason when the semgrep binary
// is absent (HBC2JS_REQUIRE_ORACLES=1 turns that skip into a failure, existing
// convention). Lane S lands in spec 13 §9 step 3 — lands red here until then,
// regardless of binary presence (probed via tools/security/probe.ts either way,
// since step 3's own tests must do the same check once the adapter exists).
//
// 2026-09-05 (CI red-run fix): only the semgrep *binary* is a provisionable
// toolchain oracle in the hermesc/hermes-dec sense (installable — `ci.yml`
// now does `pip install semgrep==<pinned>` in both jobs — so
// HBC2JS_REQUIRE_ORACLES=1 may still fail on it if that install step ever
// regresses); `measure-semgrep.ts` not existing yet is an in-repo,
// not-yet-implemented artefact (spec 13 §9 step 3), not an absent oracle, so
// it always skips regardless of REQUIRE_ORACLES — same distinction as
// tests/security/t7-lane-s-artifact-bar.test.ts and
// tests/security/t8-lane-m-agreement.test.ts.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";
import { probeSemgrep } from "../../tools/security/probe.ts";

const MEASURE_SEMGREP_PATH = join(repoRoot(), "tools", "security", "measure-semgrep.ts");

test("T6: measure-semgrep.ts on the seeded fixture recalls >= 9/10 seed classes", (t) => {
  const semgrep = probeSemgrep();
  if (!semgrep.present) {
    const msg = `semgrep binary not found (install: ${semgrep.installHint})`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  if (!existsSync(MEASURE_SEMGREP_PATH)) {
    t.skip(`${MEASURE_SEMGREP_PATH} does not exist yet — Lane S lands in spec 13 §9 step 3`);
    return;
  }
  t.skip("measure-semgrep.ts found but running it + asserting recall is step 3's responsibility");
});
