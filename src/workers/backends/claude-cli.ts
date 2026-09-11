// src/workers/backends/claude-cli.ts -- spec 28 section 9.1 "ClaudeCliBackend
// (default)". Fred's ruling (2026-09-11, verbatim): "It should run on the
// Claude plan on the shell ... they should not be using the API because API
// is more expensive. You should have an API option if it's easy to
// integrate, but you should not be going through API as default." This is
// that default: it spawns the `claude` CLI (`-p`, headless) instead of
// calling the Anthropic Messages API directly (`haiku.ts`, now opt-in).
//
// Same cache-first behaviour, same `cacheKey` inputs and same skill loading
// as `HaikuBackend`, so a recording made against either backend replays for
// the other as long as the `model` field matches (spec 28 section 9.1's
// cache-key discipline: content cannot migrate between fields to forge a
// hit). This is the second (and, with `haiku.ts`, only) place in the project
// allowed to reach outside the process -- here by `child_process.spawn`, no
// shell, never a string command line. `src/readability/**` still imports no
// transport module (tests/gate/llm-readability/interface-shape.test.ts).
import { spawn } from "node:child_process";
import { loadSkill } from "../../readability/skills.ts";
import { cacheKey, parseReadabilityResult, SKILL_FOR_KIND, ReadabilityConfigError } from "../../readability/types.ts";
import type { ClaudeCliBackendConfig } from "../../readability/types.ts";
import { readCacheEntry, writeCacheEntry } from "../../readability/cache.ts";
import { TransientBackendError } from "../backend.ts";
import type { WorkerBackend, WorkerJobRequest, WorkerJobResponse } from "../backend.ts";
import { bodyFromContext, canonicaliseContext } from "./haiku.ts";

/** The one JSON object `claude -p --output-format json` prints on stdout
 *  (verified against `claude` 2.1.268, 2026-09-11 -- see spec 28 section
 *  9.1's "Verified behaviour of the CLI"). Every field is optional in the
 *  type because a hostile or truncated process must never crash the parser
 *  (spec 28 section 9.1: malformed output is a rejected candidate). */
interface ClaudeCliResponse {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly stop_reason?: string;
  readonly session_id?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  readonly total_cost_usd?: number;
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

/** Runs `claudeBin -p --model <model> --output-format json --tools ""
 *  --no-session-persistence --system-prompt <systemPrompt>`, with the prompt
 *  itself written to stdin rather than argv (docs/BUGS.md: a function's
 *  rendered source can be large enough to blow `ARG_MAX` -- `claude -p`'s own
 *  help text calls `-p`/`--print` "useful for pipes", i.e. reads the prompt
 *  from stdin when no positional prompt is given). No shell, so neither the
 *  prompt nor the system-prompt content is ever re-interpreted. Exported for
 *  the unit test to exercise the argv it builds without spawning anything. */
export function claudeCliArgs(config: ClaudeCliBackendConfig, systemPrompt: string): readonly string[] {
  return ["-p", "--model", config.model, "--output-format", "json", "--tools", "", "--no-session-persistence", "--system-prompt", systemPrompt];
}

function runClaudeCli(config: ClaudeCliBackendConfig, args: readonly string[], prompt: string, signal?: AbortSignal): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { stdio: ["pipe", "pipe", "pipe"], ...(signal !== undefined ? { signal } : {}) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new ReadabilityConfigError(`ClaudeCliBackend: binary not found: ${config.claudeBin} (set ${"HBC2JS_CLAUDE_BIN"})`));
        return;
      }
      reject(new TransientBackendError(`ClaudeCliBackend: spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    // A process that exits (or closes stdin) before reading all of it turns
    // the write into EPIPE; that is not this call's failure mode -- `close`
    // above already carries the real exit code and whatever stdout/stderr the
    // process produced, so this handler only stops the write from becoming an
    // unhandled 'error' event and crashing the whole process (spec 28 section
    // 10 landing 1b hand smoke, 2026-09-11: an unhandled EPIPE here crashed
    // `tools/readability/record.ts` outright).
    child.stdin.on("error", () => undefined);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export class ClaudeCliBackend implements WorkerBackend {
  readonly id = "claude-cli";
  private readonly config: ClaudeCliBackendConfig;

  constructor(config: ClaudeCliBackendConfig) {
    this.config = config;
  }

  async run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse> {
    const skillId = SKILL_FOR_KIND[req.kind];
    if (skillId === undefined) {
      throw new Error(`ClaudeCliBackend: job kind "${req.kind}" has no routed skill (SKILL_FOR_KIND)`);
    }
    const skill = loadSkill(skillId, this.config.skillsDir);
    const body = bodyFromContext(req.context);
    const context = canonicaliseContext(req.context);
    const key = cacheKey({ kind: req.kind, skillId, skillVersion: skill.version, model: this.config.model, body, context });

    const cached = readCacheEntry(this.config.cacheDir, key);
    if (cached !== undefined) {
      return { text: cached.responseText, ...(cached.cost !== undefined ? { cost: cached.cost } : {}) };
    }

    // "prompt = context, system prompt = skill body" (spec 28 section 9.1):
    // unlike HaikuBackend's single concatenated user message, the CLI has a
    // dedicated system-prompt channel, so the skill discipline and the
    // per-job data are sent as two separate fields instead of being joined.
    const args = claudeCliArgs(this.config, skill.body);

    let spawned: SpawnResult;
    try {
      spawned = await runClaudeCli(this.config, args, context, signal);
    } catch (e) {
      if (e instanceof ReadabilityConfigError || e instanceof TransientBackendError) throw e;
      throw new TransientBackendError(`ClaudeCliBackend: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (spawned.timedOut) {
      throw new TransientBackendError(`ClaudeCliBackend: timed out after ${String(this.config.timeoutMs)}ms`);
    }
    if (spawned.code !== 0) {
      throw new TransientBackendError(`ClaudeCliBackend: exited ${String(spawned.code)}: ${spawned.stderr.trim()}`);
    }

    let parsed: ClaudeCliResponse;
    try {
      parsed = JSON.parse(spawned.stdout) as ClaudeCliResponse;
    } catch (e) {
      throw new TransientBackendError(`ClaudeCliBackend: could not parse CLI output as JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed.is_error === true) {
      throw new TransientBackendError(`ClaudeCliBackend: is_error: ${parsed.result ?? "(no result text)"}`);
    }

    // `stop_reason === "max_tokens"` is a rejected candidate, not a throw
    // (spec 28 section 9.1): whatever text came back is handed on exactly
    // like any other result, and `parseReadabilityResult` downstream treats
    // anything that fails to parse as an abstention, never a crash.
    const text = parsed.result ?? "";
    const usage = parsed.usage ?? {};
    const tokensIn = sumDefined(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
    const tokensOut = usage.output_tokens;
    const cost = {
      ...(tokensIn !== undefined ? { tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokensOut } : {}),
      // Informational only -- the project's budget accounting is tokens, not
      // dollars (spec 28 section 9.1's table); `usd` is never read by the
      // budget-stop logic (`src/readability/name-pass.ts`).
      ...(parsed.total_cost_usd !== undefined ? { usd: parsed.total_cost_usd } : {}),
    };
    const result = parseReadabilityResult(text);
    writeCacheEntry(this.config.cacheDir, {
      key,
      responseText: text,
      result: result.ok ? result.result : { names: [], abstained: true },
      cost,
    });
    return { text, cost };
  }
}

function sumDefined(...values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => a + b, 0);
}
