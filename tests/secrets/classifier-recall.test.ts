// T2 (spec 12 §8) — classifier recall/FP on the seeded ground-truth fixture.
// Step 1 (`src/secrets/classify.ts`, pure `classify(value): Hit[]`) has not
// landed yet at impl step 0; this test guards its import (same technique as
// tests/project/tag-supersession.test.ts) so a missing module is a clean red
// assertion failure, never a module-not-found crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGroundTruth } from "./support/materialize.ts";

const CLASSIFY_PATH = "../../src/secrets/classify.ts";

interface Hit {
  patternId: string;
  category: string;
  tier?: "A" | "B" | "C";
  span: [number, number];
}

// loadGroundTruth() reverses the fixture's at-rest defused encoding (see
// tests/fixtures/secrets/seeded/README.md) so `gt.secrets[].value` is the
// real-format value the classifier is expected to match.
const gt = loadGroundTruth();

test("T2 classifier recall (100% tier A, >=95% overall) + zero hits on near-misses", async () => {
  const mod = (await import(CLASSIFY_PATH).catch(() => null)) as null | { classify: (value: string) => Hit[] };
  assert.ok(mod, `${CLASSIFY_PATH} does not exist yet (spec 12 §9 step 1)`);
  if (!mod) return;
  const { classify } = mod;

  let foundA = 0, totalA = 0, foundAll = 0;
  for (const s of gt.secrets) {
    if (s.tier === "-") continue; // tag-category rows are not secret findings
    totalA += s.tier === "A" ? 1 : 0;
    const hits = classify(s.value);
    const match = hits.some((h) => h.patternId === s.patternId && h.tier === s.tier);
    if (match) {
      foundAll++;
      if (s.tier === "A") foundA++;
    }
  }
  const secretRows = gt.secrets.filter((s) => s.tier !== "-");
  assert.equal(foundA, totalA, "100% recall required on tier-A patterns (§7.2)");
  assert.ok(foundAll / secretRows.length >= 0.95, `overall recall ${foundAll}/${secretRows.length} must be >= 95%`);

  for (const nm of gt.nearMisses) {
    const hits = classify(nm.value).filter((h) => h.tier); // secret-tier hits only
    assert.equal(hits.length, 0, `near-miss unexpectedly hit: ${JSON.stringify(nm.value)}`);
  }
});
