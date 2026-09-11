// Spec 28 section 7 "Cost" target: a whole-src pass stays under a stated token
// budget, and the content-hash cache makes a re-run >= 90% cheaper. The key
// function is green today; the measured targets need landing 1's HaikuBackend +
// cache and are RED-SKIPPED until then (spec 13's convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cacheKey } from "../../../src/readability/types.ts";
import type { CacheKeyInput } from "../../../src/readability/types.ts";

const HAIKU_BACKEND_PATH = join(repoRoot(), "src", "workers", "backends", "haiku.ts");

const base: CacheKeyInput = {
  kind: "suggest-name",
  skillId: "hbc-name",
  skillVersion: 1,
  model: "claude-haiku-4-5-20251001",
  body: "function f(a){return a+1}",
  context: '{"strings":["x"]}',
};

test("spec 28: the cache key is content-addressed -- identical requests share it, any difference splits it", () => {
  assert.equal(cacheKey(base), cacheKey({ ...base }));
  assert.match(cacheKey(base), /^[0-9a-f]{64}$/);

  const variants: CacheKeyInput[] = [
    { ...base, kind: "name-module" },
    { ...base, skillId: "hbc-classify" },
    { ...base, skillVersion: 2 },
    { ...base, model: "claude-other" },
    { ...base, body: `${base.body} ` },
    { ...base, context: '{"strings":["y"]}' },
  ];
  const keys = new Set([cacheKey(base), ...variants.map(cacheKey)]);
  assert.equal(keys.size, variants.length + 1, "every field must participate in the key");
});

test("spec 28: the cache key cannot be forged by moving content between fields", () => {
  // Without length prefixes, body "ab"+context "c" and body "a"+context "bc"
  // would hash the same string. They must not.
  const a = cacheKey({ ...base, body: "ab", context: "c" });
  const b = cacheKey({ ...base, body: "a", context: "bc" });
  assert.notEqual(a, b);
});

test("spec 28 section 7 (cost): a re-run over the same tree is >= 90% cheaper through the cache", (t) => {
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (HaikuBackend + cache)`);
    return;
  }
  t.skip("landing 1 owns this measurement: drive a recorded backend twice over one tree and assert calls2 <= 0.1 * calls1");
});

test("spec 28 section 7 (cost): a batch pass stops cleanly at the token budget", (t) => {
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (budget stop)`);
    return;
  }
  t.skip("landing 1 owns this: a budget smaller than the tree must stop after the highest-evidence targets, not mid-write");
});
