#!/usr/bin/env node
// tests/support/stub-claude.mjs -- a fake `claude` binary shared by two
// gates: `tests/workers/claude-cli-backend.test.ts` (env-var-driven, the
// ORIGINAL use of this file -- see that test for the scenarios) and
// `tests/readability/agent-driver.test.ts` (docs/lanes/readability.md queue
// item 1, checkpoint (b)), which triggers a SEPARATE mode below whenever
// `--mcp-config <path>` is present in argv -- the env-var modes never pass
// that flag, so the two behaviours cannot collide.
//
// Env vars (claude-cli-backend.test.ts's original modes, unchanged):
//   STUB_CLAUDE_ECHO_ARGV=1   print one JSON object whose `result` field is
//                             `JSON.stringify({model, systemPrompt, prompt})`
//                             built from the received argv -- proves the
//                             backend built the right command line.
//   STUB_CLAUDE_STDOUT=<text> print this exact text to stdout instead
//                             (malformed JSON / is_error / max_tokens cases).
//   STUB_CLAUDE_EXIT_CODE=<n> exit with this code instead of 0.
//   STUB_CLAUDE_SLEEP_MS=<n>  sleep this long before responding, so a short
//                             `timeoutMs` in the backend config fires first.
//   STUB_CLAUDE_CLOSE_STDIN_EARLY=1  exit immediately WITHOUT reading stdin
//                             (a real `claude` build might not always read
//                             the prompt from stdin) -- the parent's
//                             `stdin.write()` must not crash the process.
//
// `--mcp-config <path>` mode (checkpoint (b)'s own use): reads the config's
// `mcpServers.hbc2js` entry exactly like a real MCP client would, spawns the
// REAL `hbc2js mcp-server` it names as ITS OWN child process, drives one
// canned tool-call transcript over stdio JSON-RPC (a `suggest_names` call,
// then a `promote_change` call as `worker:haiku`, refused), and prints one
// `{result, usage}` JSON object -- the same shape `claude -p --output-format
// json` prints for real. No model, no network, in either mode.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

// --- mcp-config transcript mode (checkpoint (b)) ----------------------------

function callMcpServer(serverCfg, calls) {
  const child = spawn(serverCfg.command, serverCfg.args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiters = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === "") continue;
      const res = JSON.parse(line);
      const w = waiters.get(res.id);
      if (w !== undefined) {
        waiters.delete(res.id);
        w(res);
      }
    }
  });
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  return (async () => {
    await call("initialize", {});
    const results = {};
    for (const { name, tool, arguments: toolArgs } of calls) {
      results[name] = await call("tools/call", { name: tool, arguments: toolArgs });
    }
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
    return results;
  })();
}

async function runMcpTranscript() {
  const configPath = flag("--mcp-config");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const serverCfg = config.mcpServers.hbc2js;
  const results = await callMcpServer(serverCfg, [
    { name: "suggest", tool: "suggest_names", arguments: { target: { fn: 0 } } },
    { name: "promote", tool: "promote_change", arguments: { who: "worker:haiku", suggestionId: "does-not-exist" } },
  ]);
  const suggestText = results.suggest.result.content[0].text;
  const promoteRes = results.promote.result;
  const promoteText = promoteRes.content[0].text;
  const summary = [
    "DONE",
    JSON.stringify({
      scope: { fn: 0 },
      investigated: ["fn:0 via suggest_names"],
      wrote: [{ tool: "suggest_names", target: { fn: 0 }, result: suggestText }],
      refusals: promoteRes.isError === true ? [{ tool: "promote_change", reason: promoteText }] : [],
      abstained: [],
    }),
  ].join("\n");
  await write(JSON.stringify({ result: summary, usage: { input_tokens: 1234, output_tokens: 321 }, is_error: false }));
  process.exitCode = 0;
}

// --- claude-cli-backend.test.ts's original env-var modes (unchanged) ------

async function runEnvVarModes() {
  if (process.env["STUB_CLAUDE_CLOSE_STDIN_EARLY"] === "1") {
    process.stdout.write(JSON.stringify({ result: "closed-early", is_error: true }));
    process.exit(1);
  }

  const sleepMs = process.env["STUB_CLAUDE_SLEEP_MS"];
  if (sleepMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, Number(sleepMs)));
  }
  // The real CLI reads the prompt from stdin when `-p` has no positional
  // value (ClaudeCliBackend always writes it there, to stay well under
  // ARG_MAX for a large function's rendered source). Drain it even in modes
  // that do not echo it, so the parent's `stdin.end()` always completes.
  const stdinPrompt = await readStdin();

  const exitCode = process.env["STUB_CLAUDE_EXIT_CODE"];
  if (exitCode !== undefined) {
    process.stderr.write("stub-claude: forced non-zero exit\n");
    process.exit(Number(exitCode));
  }

  const rawStdout = process.env["STUB_CLAUDE_STDOUT"];
  if (rawStdout !== undefined) {
    await write(rawStdout);
    process.exitCode = 0;
    return;
  }

  if (process.env["STUB_CLAUDE_ECHO_ARGV"] === "1") {
    const echoed = { model: flag("--model"), systemPrompt: flag("--system-prompt"), prompt: stdinPrompt };
    const response = {
      result: JSON.stringify(echoed),
      is_error: false,
      stop_reason: "end_turn",
      session_id: "stub-session",
      usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 2 },
      modelUsage: { [echoed.model ?? "unknown"]: { inputTokens: 11, outputTokens: 7 } },
      total_cost_usd: 0.0042,
    };
    await write(JSON.stringify(response));
    process.exitCode = 0;
    return;
  }

  // No mode selected: behave like a well-formed abstention.
  await write(JSON.stringify({ result: JSON.stringify({ names: [], abstained: true }), is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exitCode = 0;
}

// A large `process.stdout.write()` followed by an immediate `process.exit()`
// can truncate the write before the pipe drains (a well-known Node gotcha) --
// this is what makes `--model` and `--system-prompt` echo back reliably
// however large the echoed prompt is. Waiting for the callback and letting
// the process exit naturally (via `exitCode`, not `exit()`) avoids it.
function write(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

async function main() {
  if (flag("--mcp-config") !== undefined) {
    await runMcpTranscript();
    return;
  }
  await runEnvVarModes();
}

main();
