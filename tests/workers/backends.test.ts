// Spec 28 landing 1: `HaikuBackend` and `ReplayBackend`, the two real
// `WorkerBackend` implementations this landing adds. No test here ever
// touches the network -- `HaikuBackend`'s tests stub `globalThis.fetch`
// so the cache-hit path is exercised with the REAL cache code and the
// REAL backend, never a fake standing in for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { HaikuBackend } from "../../src/workers/backends/haiku.ts";
import { loadRecording, ReplayBackend } from "../../src/workers/backends/replay.ts";
import { readCacheEntry } from "../../src/readability/cache.ts";
import type { HaikuBackendConfig } from "../../src/readability/types.ts";
import type { WorkerJobRequest } from "../../src/workers/backend.ts";

const SKILLS_DIR = join(repoRoot(), "skills");
const RECORDING_PATH = join(repoRoot(), "tests", "fixtures", "llm-readability", "synthetic.recording.json");

function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "hbc2js-llm-cache-"));
}

function config(cacheDir: string, overrides: Partial<HaikuBackendConfig> = {}): HaikuBackendConfig {
  return {
    model: "claude-haiku-4-5-20251001",
    budgetTokens: 2000000,
    cacheDir,
    skillsDir: SKILLS_DIR,
    maxOutputTokens: 2048,
    apiKeyEnv: "HBC2JS_TEST_LLM_KEY",
    ...overrides,
  };
}

function req(fn: number, reg: number): WorkerJobRequest {
  const source = `function f${String(fn)}(){ return r${String(reg)}; }`;
  return { kind: "suggest-name", prompt: "", context: { target: `{${String(fn)},${String(reg)}}`, fn, reg, source } };
}

test("HaikuBackend: a cache hit never calls fetch", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("must not call the network");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  process.env["HBC2JS_TEST_LLM_KEY"] = "test-key";
  t.after(() => {
    delete process.env["HBC2JS_TEST_LLM_KEY"];
  });

  // Prime the cache the way `writeCacheEntry` would, without a real call:
  // the assertion is about the READ path, so build it through a first,
  // stubbed-success `run()` rather than poking the cache file directly.
  globalThis.fetch = ((): Promise<Response> => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ content: [{ type: "text", text: '{"names":[],"abstained":true}' }], usage: { input_tokens: 5, output_tokens: 2 } }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  const backend = new HaikuBackend(config(cacheDir));
  const first = await backend.run(req(1, 2));
  assert.equal(first.text, '{"names":[],"abstained":true}');
  assert.equal(calls, 1);
  assert.ok(readCacheEntry(cacheDir, "nonexistent") === undefined, "unrelated keys stay unpopulated");

  // Second call, same request: must hit the cache, never touch fetch again.
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("must not call the network on a cache hit");
  }) as typeof fetch;
  const second = await backend.run(req(1, 2));
  assert.equal(second.text, first.text);
  assert.equal(calls, 1, "the second run must not have called fetch at all");
});

test("HaikuBackend: refuses to run without the configured API key env var set", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  delete process.env["HBC2JS_TEST_LLM_KEY_UNSET"];
  const backend = new HaikuBackend(config(cacheDir, { apiKeyEnv: "HBC2JS_TEST_LLM_KEY_UNSET" }));
  await assert.rejects(() => backend.run(req(9, 9)), /HBC2JS_TEST_LLM_KEY_UNSET/);
});

test("ReplayBackend: replays a committed recording for the same request HaikuBackend would build", async () => {
  const recording = loadRecording(RECORDING_PATH);
  const backend = new ReplayBackend(recording, { model: "claude-haiku-4-5-20251001", skillsDir: SKILLS_DIR });
  const res = await backend.run(req(100, 3));
  const parsed = JSON.parse(res.text) as { names: readonly { name: string }[] };
  assert.equal(parsed.names[0]?.name, "sessionToken");
  assert.equal(backend.seen.length, 1);
});

test("ReplayBackend: a miss errors loudly with the key, so a stale recording fails rather than rots", async () => {
  const recording = loadRecording(RECORDING_PATH);
  const backend = new ReplayBackend(recording, { model: "claude-haiku-4-5-20251001", skillsDir: SKILLS_DIR });
  await assert.rejects(() => backend.run(req(999, 999)), /no recording for key/);
});
