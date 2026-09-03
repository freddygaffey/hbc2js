// T3 (spec 12 §8) — pattern <-> fixture closure. Fixture-only: needs only
// src/secrets/patterns.ts and the seeded ground-truth fixture, both of which
// land in impl step 0, so unlike T2/T4-T8 this genuinely passes now (per
// §2.2's extension rule: "a pattern nobody measures cannot ship").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PATTERNS } from "../../src/secrets/patterns.ts";

test("T3 every PATTERNS[].id appears in the seeded ground-truth fixture", () => {
  const fixtureDir = fileURLToPath(new URL("../fixtures/secrets/seeded/", import.meta.url));
  const gt = JSON.parse(readFileSync(fixtureDir + "ground-truth.json", "utf8")) as {
    secrets: { patternId: string }[];
  };
  const covered = new Set(gt.secrets.map((s) => s.patternId));
  const missing = PATTERNS.map((p) => p.id).filter((id) => !covered.has(id));
  assert.deepEqual(missing, [], `patterns with no ground-truth coverage: ${missing.join(", ")}`);
});
