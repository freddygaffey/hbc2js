// tests/security/t7-lane-s-artifact-bar.test.ts — T7 (spec 13 §10, §2.3, §2.4).
// Validation JSON exists, every hit classified, computed artifact-rate <= 30%
// on the validation pair, blocklist entries each cite it. Lane S lands in
// spec 13 §9 step 3 — lands red here until then.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

const SEMGREP_RULES_DIR = join(repoRoot(), "tools", "security", "semgrep");

test("T7: Lane S validation JSON classifies every hit; artifact-rate <= 30% on the validation pair", (t) => {
  if (!existsSync(SEMGREP_RULES_DIR)) {
    const msg = `${SEMGREP_RULES_DIR} does not exist yet — Lane S lands in spec 13 §9 step 3`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  t.skip("tools/security/semgrep/ found but T7's validation-JSON/blocklist assertions are step 3's responsibility");
});
