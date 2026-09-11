// Spec 28 section 7 "Cost" target: a whole-src pass stays under a stated token
// budget, and the content-hash cache makes a re-run >= 90% cheaper. The key
// function is green today; the measured targets need landing 1's HaikuBackend +
// cache and are RED-SKIPPED until then (spec 13's convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cacheKey } from "../../../src/readability/types.ts";
import type { CacheKeyInput, HaikuBackendConfig } from "../../../src/readability/types.ts";
import { HaikuBackend } from "../../../src/workers/backends/haiku.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { runNamePass } from "../../../src/readability/name-pass.ts";
import type { NamePassTarget } from "../../../src/readability/name-pass.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../../src/name-overlay/index.ts";

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

const FIXTURE = "04-for-loop-basic";

function analysisFor(name: string): ReturnType<typeof analyseModule> {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));
  return analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: true });
}

function haikuConfig(cacheDir: string): HaikuBackendConfig {
  return {
    model: "claude-haiku-4-5-20251001",
    budgetTokens: 2000000,
    cacheDir,
    skillsDir: join(repoRoot(), "skills"),
    maxOutputTokens: 2048,
    apiKeyEnv: "HBC2JS_TEST_COST_CACHE_KEY",
  };
}

function target(fn: number, reg: number, source: string): NamePassTarget {
  const id = regId(fn, reg);
  return { bindingId: id, kind: "suggest-name", context: { target: shortForm(id), fn, reg, source } };
}

test("spec 28 section 7 (cost): a re-run over the same tree is >= 90% cheaper through the cache", async (t) => {
  const cacheDir = mkdtempSync(join(tmpdir(), "hbc2js-cost-cache-"));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  process.env["HBC2JS_TEST_COST_CACHE_KEY"] = "test-key";
  t.after(() => {
    delete process.env["HBC2JS_TEST_COST_CACHE_KEY"];
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let networkCalls = 0;
  globalThis.fetch = ((): Promise<Response> => {
    networkCalls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ names: [{ bindingId: { fn: 0, reg: 9 }, name: "loopCount", confidence: "high", evidence: "e" }], abstained: false }) }],
          usage: { input_tokens: 30, output_tokens: 10 },
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch;

  const targets = [target(0, 9, "function f0(){ for (let r9=0;r9<10;r9++) {} }")];
  const backend = new HaikuBackend(haikuConfig(cacheDir));

  const run1 = await runNamePass(targets, { backend, service: new NameService(analysisFor(FIXTURE), new OverlayStore({ bundle: FIXTURE })) });
  assert.equal(run1.equiv.verdict, "PASS");
  const callsAfterRun1 = networkCalls;
  assert.ok(callsAfterRun1 >= 1, "the first run must have called the network at least once");

  // Second run over the SAME tree, a fresh overlay -- only the cache (keyed
  // on request content, not on the overlay's state) should make this cheap.
  const run2 = await runNamePass(targets, { backend, service: new NameService(analysisFor(FIXTURE), new OverlayStore({ bundle: FIXTURE })) });
  assert.equal(run2.equiv.verdict, "PASS");
  const callsInRun2 = networkCalls - callsAfterRun1;
  assert.ok(callsInRun2 <= 0.1 * callsAfterRun1, `re-run must be >= 90% cheaper: ${String(callsInRun2)} vs ${String(callsAfterRun1)}`);
});

test("spec 28 section 7 (cost): a batch pass stops cleanly at the token budget", async () => {
  const service = new NameService(analysisFor(FIXTURE), new OverlayStore({ bundle: FIXTURE }));
  const targets = [target(0, 9, "s1"), target(0, 12, "s2")];
  const backend = new FakeBackend({
    replies: {
      "suggest-name": (req) =>
        JSON.stringify({ names: [{ bindingId: { fn: 0, reg: req.context["reg"] }, name: "x", confidence: "high", evidence: "e" }], abstained: false }),
    },
  });
  const result = await runNamePass(targets, { backend, service, budgetTokens: 1 });
  assert.equal(result.stoppedAtBudget, true);
  assert.ok(result.outcomes.length === 2, "the budget-stopped target still gets a recorded outcome, not silence");
  assert.equal(result.outcomes[1]?.reason, "budget-stopped");
  // Highest-evidence-first ordering is the CALLER's job (spec 28 section 3);
  // this asserts the stop itself is clean -- it never half-writes a target.
  assert.ok(result.outcomes.every((o) => o.written === true || o.reason !== undefined));
});
