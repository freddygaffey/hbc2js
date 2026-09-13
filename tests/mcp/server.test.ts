// tests/mcp/server.test.ts -- docs/lanes/readability.md queue item 1,
// checkpoint (a). A real child-process round trip against `hbc2js
// mcp-server`: initialize, list tools, call `get_context` (a spec-17 read)
// and `suggest_names` (a spec-28 readability tool) with the `fake` backend,
// and confirm `promote_change` is refused as `worker:haiku` (spec 28
// section 1d, "only a human or an opt-in evaluator promotes"). This is the
// PROTOCOL round trip; `registerReadabilityTools`' own argument-validation
// and gate behaviour is `tests/mcp/readability-tools.test.ts`'s job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
// A construct fixture (single-script, no CJS `__d()` modules) gets zero
// `ix_ranges` rows from `splitProject`/`init`, so `context`/`source` throw
// "no range recorded" for every fn (tests/mcp/resources.test.ts's own
// fixture note) -- the read-tool half of this test needs a real bundle. fn
// 188 is known (same test file) to own a real source range.
const PROJECT_HBC = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const TEST_FN = 188;
// `suggest_names`' `loadAnalysis` re-parses+re-analyses the WHOLE bytecode
// file behind `ctx.hbcPath` from scratch, on every call (docs/lanes/
// readability.md's own gotcha: "a run that did this on NSW took 38 minutes
// ... always bound real runs"). `rn-template`'s 4,199 functions made that
// one call alone run past a 90s timeout with no result. This is a PROTOCOL
// round trip, not a semantic one: `--hbc` for the readability half is
// deliberately a SEPARATE, tiny construct fixture (same one
// tests/gate/llm-readability/surfaces.test.ts uses) so the call returns in
// milliseconds; nothing here relies on the project dir and the readability
// backend's `--hbc` describing the same bytecode.
const READABILITY_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Drives one `hbc2js mcp-server` child process over stdio: newline-
 *  delimited JSON-RPC 2.0 requests in, responses matched back by `id`. */
class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly waiters = new Map<number, (res: JsonRpcResponse) => void>();

  constructor(projectDir: string, extraArgs: readonly string[] = []) {
    this.child = spawn(process.execPath, [CLI, "mcp-server", projectDir, "--hbc", READABILITY_HBC, "--llm-backend", "fake", ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.child.stdout, terminal: false });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const res = JSON.parse(trimmed) as JsonRpcResponse;
      if (typeof res.id === "number") this.waiters.get(res.id)?.(res);
    });
  }

  call(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return new Promise((resolve) => {
      this.child.on("close", (code) => resolve(code));
    });
  }
}

function toolResultText(res: JsonRpcResponse): { readonly text: string; readonly isError: boolean } {
  const r = res.result as { readonly content: readonly { readonly text: string }[]; readonly isError?: boolean };
  return { text: r.content[0]?.text ?? "", isError: r.isError === true };
}

test("hbc2js mcp-server: stdio JSON-RPC round trip -- initialize, tools/list, get_context, suggest_names (fake backend), promote_change refusal", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-server-"));
  try {
    const projectDir = join(workDir, "project");
    const init = spawnSync(process.execPath, [CLI, "init", PROJECT_HBC, "--out", projectDir], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);

    const client = new McpClient(projectDir);
    try {
      const initRes = await client.call("initialize", {});
      const initResult = initRes.result as { readonly serverInfo: { readonly name: string } };
      assert.equal(initResult.serverInfo.name, "hbc2js");

      const listRes = await client.call("tools/list", {});
      const listResult = listRes.result as { readonly tools: readonly { readonly name: string }[] };
      const names = listResult.tools.map((t) => t.name);
      assert.ok(names.includes("get_context"), `tools/list should include get_context, got ${names.join(",")}`);
      assert.ok(names.includes("suggest_names"), "tools/list should include the readability tools when the project has a readable src/ tree");
      assert.ok(names.includes("promote_change"));
      assert.ok(names.includes("set_name"), "tools/list should include the spec-17 write tools too");

      const contextRes = await client.call("tools/call", { name: "get_context", arguments: { fn: TEST_FN } });
      const context = toolResultText(contextRes);
      assert.equal(context.isError, false, context.text);
      const parsedContext = JSON.parse(context.text) as { readonly fn: number };
      assert.equal(parsedContext.fn, TEST_FN);

      const suggestRes = await client.call("tools/call", { name: "suggest_names", arguments: { target: { fn: 0 } } });
      const suggest = toolResultText(suggestRes);
      assert.equal(suggest.isError, false, suggest.text);
      const parsedSuggest = JSON.parse(suggest.text) as { readonly suggestions: readonly unknown[]; readonly equiv: { readonly verdict: string } };
      assert.ok(Array.isArray(parsedSuggest.suggestions));
      assert.ok(["PASS", "DIVERGENT", "INCONCLUSIVE"].includes(parsedSuggest.equiv.verdict));

      const promoteRes = await client.call("tools/call", { name: "promote_change", arguments: { who: "worker:haiku", suggestionId: "does-not-exist" } });
      const promote = toolResultText(promoteRes);
      assert.equal(promote.isError, true, "promote_change as worker:haiku must be refused, not silently accepted");
      assert.match(promote.text, /worker:haiku/);
      assert.match(promote.text, /may not/);
    } finally {
      const code = await client.close();
      assert.equal(code, 0);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
