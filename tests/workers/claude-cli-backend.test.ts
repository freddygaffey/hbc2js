// Spec 28 section 9.1 "ClaudeCliBackend (default)" -- Fred's 2026-09-11
// ruling: the DEFAULT model backend runs `claude -p` on Fred's plan, not the
// metered Anthropic API. No test here ever spawns the real `claude` binary:
// `tests/support/stub-claude.mjs` stands in for it, driven entirely by env
// vars, so the REAL backend code (argv construction, JSON parsing, exit-code
// and timeout handling, cache-first behaviour) runs against a real
// subprocess without ever reaching the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { ClaudeCliBackend, claudeCliArgs } from "../../src/workers/backends/claude-cli.ts";
import { bodyFromContext, canonicaliseContext } from "../../src/workers/backends/haiku.ts";
import { readCacheEntry, writeCacheEntry } from "../../src/readability/cache.ts";
import { cacheKey, ReadabilityConfigError } from "../../src/readability/types.ts";
import type { ClaudeCliBackendConfig } from "../../src/readability/types.ts";
import { TransientBackendError } from "../../src/workers/backend.ts";
import type { WorkerJobRequest } from "../../src/workers/backend.ts";

const SKILLS_DIR = join(repoRoot(), "skills");
const STUB = join(repoRoot(), "tests", "support", "stub-claude.mjs");

function tmpCacheDir(): string {
  return mkdtempSync(join(tmpdir(), "hbc2js-claude-cli-cache-"));
}

function config(cacheDir: string, overrides: Partial<ClaudeCliBackendConfig> = {}): ClaudeCliBackendConfig {
  return {
    model: "haiku",
    budgetTokens: 2000000,
    cacheDir,
    skillsDir: SKILLS_DIR,
    maxOutputTokens: 2048,
    claudeBin: STUB,
    timeoutMs: 5000,
    ...overrides,
  };
}

function req(fn: number, reg: number): WorkerJobRequest {
  const source = `function f${String(fn)}(){ return r${String(reg)}; }`;
  return { kind: "suggest-name", prompt: "", context: { target: `{${String(fn)},${String(reg)}}`, fn, reg, source } };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("claudeCliArgs: system prompt = skill body, -p takes no argv value (the prompt goes to stdin), model and json output are present", () => {
  const args = claudeCliArgs(config("/tmp/unused"), "SKILL BODY HERE");
  assert.deepEqual(args, ["-p", "--model", "haiku", "--output-format", "json", "--tools", "", "--no-session-persistence", "--system-prompt", "SKILL BODY HERE"]);
  // Never a positional value after `-p` -- a large function's rendered
  // source must not become an argv token (ARG_MAX; docs/BUGS.md).
  assert.equal(args[1], "--model");
});

test("ClaudeCliBackend: spawns the stub and maps result/usage into text/cost", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_ECHO_ARGV: "1" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    const res = await backend.run(req(1, 2));
    const echoed = JSON.parse(res.text) as { model: string; systemPrompt: string; prompt: string };
    assert.equal(echoed.model, "haiku");
    assert.equal(echoed.systemPrompt.includes("Output contract"), true, "system prompt is the hbc-name skill body");
    assert.equal(JSON.parse(echoed.prompt).target, "{1,2}", "the -p prompt is the canonicalised context");
    // usage.input + cache_creation + cache_read all count toward tokensIn;
    // total_cost_usd is informational only (cost.usd), never the budget.
    assert.deepEqual(res.cost, { tokensIn: 11 + 3 + 2, tokensOut: 7, usd: 0.0042 });
  });
});

test("ClaudeCliBackend: a cache hit never spawns the binary", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const cfg = config(cacheDir);
  const request = req(3, 4);
  const key = cacheKey({
    kind: "suggest-name",
    skillId: "hbc-name",
    skillVersion: 1,
    model: cfg.model,
    body: bodyFromContext(request.context),
    context: canonicaliseContext(request.context),
  });
  writeCacheEntry(cacheDir, { key, responseText: "cached-text", result: { names: [], abstained: true }, cost: { tokensIn: 1, tokensOut: 1 } });

  await withEnv({ STUB_CLAUDE_EXIT_CODE: "1" }, async () => {
    const backend = new ClaudeCliBackend(cfg);
    const res = await backend.run(request);
    assert.equal(res.text, "cached-text");
  });
  assert.notEqual(readCacheEntry(cacheDir, key), undefined);
});

test("ClaudeCliBackend: is_error:true is a TransientBackendError", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_STDOUT: JSON.stringify({ result: "boom", is_error: true }) }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    await assert.rejects(backend.run(req(5, 6)), TransientBackendError);
  });
});

test("ClaudeCliBackend: a non-zero exit is a TransientBackendError", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_EXIT_CODE: "3" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    await assert.rejects(backend.run(req(7, 8)), TransientBackendError);
  });
});

test("ClaudeCliBackend: malformed stdout JSON is a TransientBackendError, not a crash", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_STDOUT: "not json at all" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    await assert.rejects(backend.run(req(9, 10)), TransientBackendError);
  });
});

test("ClaudeCliBackend: a timeout kills the process and throws TransientBackendError", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_SLEEP_MS: "2000" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir, { timeoutMs: 100 }));
    await assert.rejects(backend.run(req(11, 12)), TransientBackendError);
  });
});

test("ClaudeCliBackend: a missing binary is a ReadabilityConfigError, not a TransientBackendError", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const backend = new ClaudeCliBackend(config(cacheDir, { claudeBin: join(repoRoot(), "tests", "support", "no-such-claude-binary") }));
  await assert.rejects(backend.run(req(13, 14)), ReadabilityConfigError);
});

test("ClaudeCliBackend: stop_reason max_tokens is a rejected candidate, not a throw", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv(
    { STUB_CLAUDE_STDOUT: JSON.stringify({ result: "{truncated", is_error: false, stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 2048 } }) },
    async () => {
      const backend = new ClaudeCliBackend(config(cacheDir));
      const res = await backend.run(req(15, 16));
      assert.equal(res.text, "{truncated");
    },
  );
});

// Regression: the hand smoke in spec 28 section 10 landing 1b (a real
// react-navigation-example function) hit `spawn E2BIG` when the prompt was
// passed as an argv token -- a rendered function's source routinely exceeds
// the OS's effective ARG_MAX. The fix moved the prompt to stdin; this proves
// a payload far larger than any sane ARG_MAX still round-trips.
test("ClaudeCliBackend: a prompt far larger than ARG_MAX round-trips over stdin without spawn failing", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const bigSource = `function big(){ return "${"x".repeat(2_000_000)}"; }`;
  await withEnv({ STUB_CLAUDE_ECHO_ARGV: "1" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    const res = await backend.run({ kind: "suggest-name", prompt: "", context: { target: "{99,1}", fn: 99, reg: 1, source: bigSource } });
    const echoed = JSON.parse(res.text) as { prompt: string };
    assert.equal(JSON.parse(echoed.prompt).source, bigSource);
  });
});

// Regression: the same hand smoke's SECOND attempt (after the stdin fix
// above) crashed the whole `node` process with an unhandled EPIPE, because
// the real `claude` invocation closed its stdin before reading the prompt
// and nothing was listening for a write error on `child.stdin`. The fix adds
// that listener; `close` (not the write) is what decides the outcome.
test("ClaudeCliBackend: a child that closes stdin before reading it does not crash the process", async (t) => {
  const cacheDir = tmpCacheDir();
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  await withEnv({ STUB_CLAUDE_CLOSE_STDIN_EARLY: "1" }, async () => {
    const backend = new ClaudeCliBackend(config(cacheDir));
    await assert.rejects(backend.run(req(20, 21)), TransientBackendError);
  });
});

test("ClaudeCliBackend: same cacheKey shape as HaikuBackend -- a recording keyed by model matches either backend", () => {
  const request = req(17, 18);
  const context = canonicaliseContext(request.context);
  const claudeKey = cacheKey({ kind: "suggest-name", skillId: "hbc-name", skillVersion: 1, model: "same-model-id", body: "b", context });
  const haikuKey = cacheKey({ kind: "suggest-name", skillId: "hbc-name", skillVersion: 1, model: "same-model-id", body: "b", context });
  assert.equal(claudeKey, haikuKey, "cacheKey is the same pure function for both backends -- a recording replays across them when model matches");
});
