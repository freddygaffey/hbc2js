#!/usr/bin/env node
// tests/support/stub-claude.mjs -- a fake `claude` binary for
// tests/workers/claude-cli-backend.test.ts. Never touches the network; its
// entire behaviour is driven by env vars the test sets before pointing
// `ClaudeCliBackendConfig.claudeBin` at this file, so the real backend code
// (argv construction, JSON parsing, exit-code/timeout handling) runs
// unmodified against a process that behaves exactly like the real CLI would
// for that scenario.
//
// Env vars:
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
const args = process.argv.slice(2);

if (process.env["STUB_CLAUDE_CLOSE_STDIN_EARLY"] === "1") {
  process.stdout.write(JSON.stringify({ result: "closed-early", is_error: true }));
  process.exit(1);
}

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

async function main() {
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

main();
