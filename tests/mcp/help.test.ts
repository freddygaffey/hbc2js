// tests/mcp/help.test.ts -- docs/lanes/readability.md discoverability task
// (Fred, 2026-09-13): "make hbc2js discoverable to agents". Proves the
// three load-bearing claims: every `docs/agent-help/<topic>.md` file
// exists, `help` with no topic returns the tldr plus every topic, the
// tool table and `docs/agent-help/tools.md` never drift apart in either
// direction, and every `hbc2js://docs/*` resource (plus the `help` tool)
// answers over the REAL `hbc2js mcp-server` child process -- the same
// stdio JSON-RPC round trip `tests/mcp/server.test.ts` drives, reused here
// rather than re-invented (the two files share nothing but the pattern:
// this file has its own minimal `McpClient`, since importing one from a
// sibling test file is not a public API this codebase exposes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { HELP_TOPICS } from "../../src/mcp/help.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
// A construct fixture is enough here: `suggest_names`/`promote_change`/the
// general `help` tool never call `get_context`/`get_source` (the two
// resources that need real `ix_ranges` rows -- docs/lanes/readability.md's
// own gotcha, also relied on by tests/mcp/server.test.ts's sibling file),
// so a tiny fixture keeps this file's `init` + server spawn fast.
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v94.hbc");

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly waiters = new Map<number, (res: JsonRpcResponse) => void>();

  constructor(projectDir: string) {
    this.child = spawn(process.execPath, [CLI, "mcp-server", projectDir, "--hbc", FIXTURE_HBC, "--llm-backend", "fake"], { stdio: ["pipe", "pipe", "pipe"] });
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
    return new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
  }
}

function buildProject(): string {
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-help-"));
  const projectDir = join(workDir, "project");
  const init = spawnSync(process.execPath, [CLI, "init", FIXTURE_HBC, "--out", projectDir], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return projectDir;
}

function toolNamesFromToolsMd(): readonly string[] {
  const text = readFileSync(join(repoRoot(), "docs", "agent-help", "tools.md"), "utf8");
  const names: string[] = [];
  for (const m of text.matchAll(/^- `([a-z_]+)`:/gm)) {
    const name = m[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

test("docs/agent-help: every HELP_TOPICS file exists on disk", () => {
  for (const topic of HELP_TOPICS) {
    const path = join(repoRoot(), "docs", "agent-help", `${topic}.md`);
    assert.ok(existsSync(path), `missing docs/agent-help/${topic}.md`);
  }
});

test("docs/agent-help/tools.md and the MCP tool table name exactly the same tools, both directions", async () => {
  const projectDir = buildProject();
  const client = new McpClient(projectDir);
  try {
    const listRes = await client.call("tools/list", {});
    const listResult = listRes.result as { readonly tools: readonly { readonly name: string }[] };
    const tableNames = listResult.tools.map((t) => t.name).sort();
    const docNames = [...toolNamesFromToolsMd()].sort();
    assert.deepEqual(docNames, tableNames, `docs/agent-help/tools.md and the live tool table disagree:\ndocs: ${docNames.join(",")}\ntable: ${tableNames.join(",")}`);
  } finally {
    await client.close();
    rmSync(join(projectDir, ".."), { recursive: true, force: true });
  }
});

test("hbc2js mcp-server: the help tool answers, with and without a topic, over the real server", async () => {
  const projectDir = buildProject();
  const client = new McpClient(projectDir);
  try {
    const noTopic = await client.call("tools/call", { name: "help", arguments: {} });
    const noTopicResult = noTopic.result as { readonly content: readonly { readonly text: string }[]; readonly isError?: boolean };
    assert.equal(noTopicResult.isError, undefined, noTopicResult.content[0]?.text);
    const parsed = JSON.parse(noTopicResult.content[0]?.text ?? "{}") as { readonly topic: string; readonly text: string };
    assert.equal(parsed.topic, "tldr");
    assert.match(parsed.text, /hbc2js in five lines/);
    for (const topic of HELP_TOPICS) assert.match(parsed.text, new RegExp(`\`${topic}\``));

    const withTopic = await client.call("tools/call", { name: "help", arguments: { topic: "workflow" } });
    const withTopicResult = withTopic.result as { readonly content: readonly { readonly text: string }[]; readonly isError?: boolean };
    assert.equal(withTopicResult.isError, undefined);
    const parsedTopic = JSON.parse(withTopicResult.content[0]?.text ?? "{}") as { readonly topic: string; readonly text: string };
    assert.equal(parsedTopic.topic, "workflow");
    assert.match(parsedTopic.text, /Workflow: read before write/);

    const badTopic = await client.call("tools/call", { name: "help", arguments: { topic: "not-a-topic" } });
    const badTopicResult = badTopic.result as { readonly isError?: boolean };
    assert.equal(badTopicResult.isError, true);
  } finally {
    await client.close();
    rmSync(join(projectDir, ".."), { recursive: true, force: true });
  }
});

test("hbc2js mcp-server: every hbc2js://docs/* resource is listed and readable through the real server, including the index", async () => {
  const projectDir = buildProject();
  const client = new McpClient(projectDir);
  try {
    const listRes = await client.call("resources/list", {});
    const listResult = listRes.result as { readonly resources: readonly { readonly uri: string; readonly name: string }[] };
    const uris = new Set(listResult.resources.map((r) => r.uri));
    assert.ok(uris.has("hbc2js://docs/index"), `resources/list missing hbc2js://docs/index: ${[...uris].join(",")}`);
    for (const topic of HELP_TOPICS) assert.ok(uris.has(`hbc2js://docs/${topic}`), `resources/list missing hbc2js://docs/${topic}`);

    const indexRes = await client.call("resources/read", { uri: "hbc2js://docs/index" });
    const indexResult = indexRes.result as { readonly contents: readonly { readonly text: string }[] };
    assert.match(indexResult.contents[0]?.text ?? "", /hbc2js in five lines/);

    const workflowRes = await client.call("resources/read", { uri: "hbc2js://docs/workflow" });
    const workflowResult = workflowRes.result as { readonly contents: readonly { readonly text: string }[] };
    assert.match(workflowResult.contents[0]?.text ?? "", /Workflow: read before write/);
  } finally {
    await client.close();
    rmSync(join(projectDir, ".."), { recursive: true, force: true });
  }
});
