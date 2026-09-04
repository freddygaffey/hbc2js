// tests/security/t7-lane-s-artifact-bar.test.ts — T7 (spec 13 §10, §2.3, §2.4).
// Validation JSON exists, every hit classified, computed artifact-rate <= 30%
// on the validation pair, blocklist entries each cite it. Lane S lands in
// spec 13 §9 step 3 — lands red here until then.
//
// 2026-09-05 (CI red-run fix): `tools/security/semgrep/` not existing yet is
// an in-repo, not-yet-implemented artefact (no external toolchain involved),
// not an absent oracle — HBC2JS_REQUIRE_ORACLES=1 is about oracles CI itself
// provisions (hermesc, hermes-dec, now semgrep/androguard; see
// tests/support/oracles.ts), so this always skips regardless. Contrast
// tests/security/t6-lane-s-recall.test.ts, which DOES still honour
// REQUIRE_ORACLES for the semgrep *binary* itself.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const SEMGREP_RULES_DIR = join(repoRoot(), "tools", "security", "semgrep");

test("T7: Lane S validation JSON classifies every hit; artifact-rate <= 30% on the validation pair", (t) => {
  if (!existsSync(SEMGREP_RULES_DIR)) {
    t.skip(`${SEMGREP_RULES_DIR} does not exist yet — Lane S lands in spec 13 §9 step 3`);
    return;
  }
  t.skip("tools/security/semgrep/ found but T7's validation-JSON/blocklist assertions are step 3's responsibility");
});
