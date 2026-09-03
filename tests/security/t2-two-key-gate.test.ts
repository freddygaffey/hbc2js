// tests/security/t2-two-key-gate.test.ts — T2 (spec 13 §3.2, §10). Pure unit
// test of Lane O's claim/candidate classifier on a fabricated DepsReport, no
// network. The classifier itself is Lane O adapter logic (spec 13 §9 step 2)
// — out of scope for steps 0-1 — so this file lands red (skipped-with-reason,
// spec 12 step-0 precedent / tests/secrets/held-out.test.ts convention) until
// step 2 creates the module this test imports.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireOracles } from "../support/tiers.ts";

// Step 2 is expected to land the classifier here (name per spec 13 §3.2's
// "two-key rule"); adjust this path in step 2's commit if the module lands
// elsewhere, and delete this comment.
const CLASSIFIER_PATH = join(repoRoot(), "src", "security", "osv-gate.ts");

test("T2: two-key gate classifies claim/candidate/no-record on a fabricated DepsReport", (t) => {
  if (!existsSync(CLASSIFIER_PATH)) {
    const msg = `${CLASSIFIER_PATH} does not exist yet — Lane O adapter lands in spec 13 §9 step 2`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  // Left for step 2 to fill in: High+direct-version -> claim; High+date-inferred
  // version -> candidate; confidence 0.6 guess + versioned literal -> candidate
  // (identity key fails); Low/hint -> no record (spec 13 §3.2, §10 T2).
  t.skip("classifier module found but T2's assertions are step 2's responsibility to land alongside it");
});
