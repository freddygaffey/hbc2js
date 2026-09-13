// tests/readability/agent-driver.test.ts -- docs/lanes/readability.md queue
// item 1, checkpoint (b). Drives `runReadabilityAgent` against
// `tests/support/stub-claude.mjs` (a stand-in for the real `claude` binary
// that itself spawns the REAL `hbc2js mcp-server` and replays a canned
// tool-call transcript over it), so this is an end-to-end round trip
// through the driver + the checkpoint (a) server, with no model and no
// network involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { runReadabilityAgent } from "../../src/readability/agent-driver.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const STUB_CLAUDE = join(repoRoot(), "tests", "support", "stub-claude.mjs");
// Same construct fixture `tests/gate/llm-readability/surfaces.test.ts` uses
// for `suggest_names` -- a tiny, fast, real `.hbc` file (no split/module
// ranges needed here: `suggest_names`/`promote_change` never call
// `context()`/`source()`, the resources that need `ix_ranges`).
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");

test("hbc2js readability agent: stub-driven run reports its suggest_names write, surfaces a promote_change refusal, and runs the end-of-run check", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-agent-driver-"));
  try {
    const projectDir = join(workDir, "project");
    const init = spawnSync(process.execPath, [CLI, "init", FIXTURE_HBC, "--out", projectDir], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const result = await runReadabilityAgent({
      projectDir,
      hbc: FIXTURE_HBC,
      llmBackend: "fake",
      scope: { fn: 0 },
      claudeBin: STUB_CLAUDE,
      cliPath: CLI,
      maxTurns: 8,
    });

    assert.equal(result.exitCode, 0, result.resultText);
    assert.match(result.resultText, /^DONE/);
    const summary = JSON.parse(result.resultText.slice(result.resultText.indexOf("\n") + 1)) as {
      readonly wrote: readonly unknown[];
      readonly refusals: readonly { readonly tool: string; readonly reason: string }[];
    };
    assert.ok(summary.wrote.length >= 1, "the transcript's suggest_names call should be reported as written");
    assert.equal(summary.refusals.length, 1, "the transcript's promote_change call should be reported as refused");
    assert.match(summary.refusals[0]?.reason ?? "", /worker:haiku/);
    assert.match(summary.refusals[0]?.reason ?? "", /may not/);

    // The driver's OWN end-of-run check: everything the run wrote landed as
    // `suggested`, and nothing was promoted (promote_change was refused,
    // not silently accepted). The `fake` backend's default reply is plain
    // text, not the `{names:[...]}` JSON `suggest_names` requires, so this
    // real (non-mocked) call legitimately ABSTAINS -- `result.written` can
    // be empty; the invariant this loop actually proves is that IF a
    // readability write ever lands, it is never anything but `suggested`.
    for (const item of result.written) {
      const tier = item.kind === "name" ? item.tier : item.tx.tier;
      assert.equal(tier, "suggested", "nothing runReadabilityAgent touches is ever promoted");
    }
    // No source range on this construct fixture (see tests/mcp/resources.test.ts's
    // own fixture note), so the tree-equiv check is a legitimate INCONCLUSIVE/
    // undefined here -- the point of this assertion is only that running it
    // never throws.
    assert.ok(result.equiv === undefined || ["PASS", "DIVERGENT", "INCONCLUSIVE"].includes(result.equiv.verdict));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("hbc2js readability agent: scope validation refuses zero or multiple of --module/--fn/--file before spawning anything", async () => {
  await assert.rejects(() => runReadabilityAgent({ projectDir: "/nonexistent", scope: {}, claudeBin: STUB_CLAUDE, cliPath: CLI }), /exactly one of/);
});

// docs/lanes/readability.md queue item 3(b): `--hbc` is required (the
// project records the bundle's sha256, never its path -- see PUSHBACK
// P-66) and fails fast, before spawning `claude` at all.
test("hbc2js readability agent: --hbc is required and fails fast, before spawning anything", async () => {
  await assert.rejects(
    () => runReadabilityAgent({ projectDir: "/nonexistent", scope: { fn: 0 }, claudeBin: STUB_CLAUDE, cliPath: CLI }),
    /--hbc <bundle\.hbc> is required/,
  );
});

test("hbc2js readability agent: a --hbc that does not match the project's recorded bundle sha256 fails fast", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-agent-driver-hbc-mismatch-"));
  try {
    const projectDir = join(workDir, "project");
    const init = spawnSync(process.execPath, [CLI, "init", FIXTURE_HBC, "--out", projectDir], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const wrongHbc = join(repoRoot(), "tests", "fixtures", "constructs", "05-for-in-object", "v84.hbc");
    await assert.rejects(
      () => runReadabilityAgent({ projectDir, hbc: wrongHbc, scope: { fn: 0 }, claudeBin: STUB_CLAUDE, cliPath: CLI }),
      /does not match this project/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// docs/lanes/readability.md queue item 3(a): no built-in tool exists for
// the model to ask for -- `--tools ""` disables the whole built-in set,
// leaving only the MCP tools `--allowedTools` grants.
test("hbc2js readability agent: spawns claude with --tools \"\" (no built-in tool to ask for) alongside --allowedTools mcp__hbc2js__*", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-agent-driver-argv-"));
  try {
    const projectDir = join(workDir, "project");
    const init = spawnSync(process.execPath, [CLI, "init", FIXTURE_HBC, "--out", projectDir], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const prevEnv = process.env["STUB_CLAUDE_ECHO_MCP_ARGV"];
    process.env["STUB_CLAUDE_ECHO_MCP_ARGV"] = "1";
    try {
      const result = await runReadabilityAgent({
        projectDir,
        hbc: FIXTURE_HBC,
        scope: { fn: 0 },
        claudeBin: STUB_CLAUDE,
        cliPath: CLI,
        maxTurns: 8,
      });
      const echoed = JSON.parse(result.resultText) as { readonly argv: readonly string[] };
      const toolsIdx = echoed.argv.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools in argv");
      assert.equal(echoed.argv[toolsIdx + 1], "", "--tools must be followed by the empty string, disabling every built-in tool");
      const allowedIdx = echoed.argv.indexOf("--allowedTools");
      assert.ok(allowedIdx >= 0, "expected --allowedTools in argv");
      assert.equal(echoed.argv[allowedIdx + 1], "mcp__hbc2js__*");
    } finally {
      if (prevEnv === undefined) delete process.env["STUB_CLAUDE_ECHO_MCP_ARGV"];
      else process.env["STUB_CLAUDE_ECHO_MCP_ARGV"] = prevEnv;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// docs/lanes/readability.md queue item 3(d): a run that never makes a
// tool call (the exact shape of the item-2 hand smoke's `max_turns`
// failure) is reported as a failure, not a quiet success, however cleanly
// the child process itself exited.
test("hbc2js readability agent: a run with zero tool calls reports toolCalls:0 and a non-zero exitCode", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-agent-driver-zero-calls-"));
  try {
    const projectDir = join(workDir, "project");
    const init = spawnSync(process.execPath, [CLI, "init", FIXTURE_HBC, "--out", projectDir], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const prevEnv = process.env["STUB_CLAUDE_ZERO_TOOL_CALLS"];
    process.env["STUB_CLAUDE_ZERO_TOOL_CALLS"] = "1";
    try {
      const result = await runReadabilityAgent({
        projectDir,
        hbc: FIXTURE_HBC,
        scope: { fn: 0 },
        claudeBin: STUB_CLAUDE,
        cliPath: CLI,
        maxTurns: 8,
      });
      assert.equal(result.toolCalls, 0);
      assert.notEqual(result.exitCode, 0);
    } finally {
      if (prevEnv === undefined) delete process.env["STUB_CLAUDE_ZERO_TOOL_CALLS"];
      else process.env["STUB_CLAUDE_ZERO_TOOL_CALLS"] = prevEnv;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
