// T1 (spec 12 §8) — pattern-set integrity. Runnable the moment
// src/secrets/patterns.ts exists (impl step 0); lands verbatim from the spec.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, PATTERN_SET_VERSION } from "../../src/secrets/patterns.ts";

test("T1 ids unique + sourced", () => {
  const ids = PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PATTERNS) {
    assert.ok(p.source.length > 0);
    assert.ok(!p.re.test(""));
  }
  assert.match(PATTERN_SET_VERSION, /^hbc2js-secrets\/\d+$/);
});
