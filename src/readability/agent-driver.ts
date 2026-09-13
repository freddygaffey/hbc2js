// src/readability/agent-driver.ts -- docs/lanes/readability.md queue item 1,
// checkpoint (b): `hbc2js readability agent <project> --module M | --fn N |
// --file <path>`. Spawns `claude -p` as an MCP CLIENT of the checkpoint (a)
// stdio server (its own child process, per `--mcp-config`), gives it the
// `hbc-agent` skill as its system prompt and one goal prompt on stdin, waits
// for its `{result, usage}` JSON, then runs an END-OF-RUN CHECK this module
// owns (never the agent): a before/after snapshot of `list_suggestions`
// (everything the run wrote lands as `suggested`, never promoted -- nothing
// here promotes anything) and a tree-level equivalence pass over the
// project's readable tree, reusing `file-ops.ts`'s own oracle rather than
// inventing a second one.
//
// This file never itself calls a model: it spawns `claudeBin` (a real
// `claude` binary, or -- in the driver's own test -- a stub script that
// replays a canned MCP transcript against the REAL checkpoint (a) server).
// Same "no shell, argv never carries the prompt" discipline as
// `src/workers/backends/claude-cli.ts`.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReadabilityCtx } from "../ui-server/server.ts";
import { openProjectDb } from "../projdb/db.ts";
import { dbPath } from "../projdb/artifact-read.ts";
import { existsSync } from "node:fs";
import { listSuggestions, type SuggestionItem } from "./surfaces.ts";
import type { ReadabilityContext } from "./surfaces.ts";
import { defaultTreeEquivOracle, readModulesIndex, readTree, type TreeEquivResult } from "./file-ops.ts";
import { openProjectDbReadonly, readMeta } from "../projdb/artifact-read.ts";
import { sha256Hex } from "../artifact/schema.ts";

export interface AgentScope {
  readonly module?: number;
  readonly fn?: number;
  readonly file?: string;
}

export interface RunReadabilityAgentOpts {
  readonly projectDir: string;
  readonly hbc?: string;
  readonly llmBackend?: string;
  readonly scope: AgentScope;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly budgetTokens?: number;
  /** Overridable for the driver's own test (a stub script); defaults to
   *  `HBC2JS_CLAUDE_BIN` then `"claude"`, same env-override convention
   *  `claude-cli.ts`'s `resolveClaudeCliConfig` already uses. */
  readonly claudeBin?: string;
  /** Path to `src/cli.ts` this driver tells the spawned `claude` process to
   *  run as its MCP server. Defaults to THIS repo's own `src/cli.ts` (same
   *  file `runMcpServer` lives in) -- overridable so a test can point at a
   *  fixture copy if it ever needs to. */
  readonly cliPath?: string;
  readonly timeoutMs?: number;
  readonly skillsDir?: string;
}

export interface AgentRunResult {
  readonly resultText: string;
  readonly usage: { readonly tokensIn?: number; readonly tokensOut?: number };
  /** The spawned `claude` process's own exit code when it is non-zero
   *  (a real crash/timeout takes priority); otherwise `1` when `toolCalls`
   *  is `0` (item 3d: a run that made zero tool calls is a failure, not a
   *  quiet success, however cleanly the process itself exited); otherwise
   *  `0`. `null` only when the process was killed by a signal and never
   *  reported a numeric code. */
  readonly exitCode: number | null;
  /** Every suggestion/transaction present after the run that was not
   *  present before it -- a before/after diff, not a `who`-filtered live
   *  query (P-59's overlay/transaction records carry `who`, but nothing
   *  plumbs a caller-chosen run id into `suggest_names`/`rewrite_function`
   *  today; the diff is the load-tolerant proxy for "this run's writes"
   *  until that lands). Every entry here is `tier: "suggested"` by
   *  construction (`promote_change` is never called by this driver or by
   *  the skill it hands the agent). */
  readonly written: readonly SuggestionItem[];
  readonly equiv: TreeEquivResult | undefined;
  /** Count of tool calls the run itself reports (`investigated.length +
   *  wrote.length + refusals.length` from the skill's `DONE` JSON output
   *  contract) -- the only place this driver CAN count calls from: the
   *  final `claude -p --output-format json` result has no
   *  successful-tool-call field of its own (it has `permission_denials`,
   *  which records refusals to grant a tool, not calls that went through).
   *  0 when the reply is not a well-formed `DONE` payload at all, which is
   *  exactly the item-3 failure mode this field exists to catch (a run
   *  that hits `max_turns` before ever calling an MCP tool). */
  readonly toolCalls: number;
}

export class AgentDriverError extends Error {}

function goalPrompt(scope: AgentScope): string {
  if (scope.module !== undefined) return `Make module ${String(scope.module)} readable. Investigate it with get_module and get_context/get_source, then act.`;
  if (scope.fn !== undefined) return `Make function ${String(scope.fn)} readable. Investigate it with get_context or get_source, then act.`;
  if (scope.file !== undefined) return `Make the exports of ${scope.file} readable. Investigate it, then act.`;
  throw new AgentDriverError("readability agent: scope must name exactly one of --module, --fn, --file");
}

/** `skills/hbc-agent.md`'s body, stripped of front matter -- deliberately
 *  NOT `src/readability/skills.ts`'s `loadSkill`/`parseSkill`: those enforce
 *  every declared `kind` routes through `SKILL_FOR_KIND` (a `JobKind`), and
 *  `agent` is not a worker-queue job kind (this driver spawns `claude -p`
 *  directly, never through `WorkerRunner`) -- adding a fake job kind just to
 *  satisfy that check would be a bigger, riskier change than this file
 *  reading its own skill directly. */
function loadAgentSkillBody(skillsDir: string): string {
  const path = join(skillsDir, "hbc-agent.md");
  const text = readFileSync(path, "utf8");
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new AgentDriverError(`${path}: missing the leading --- front matter block`);
  const body = (m[1] ?? "").trim();
  if (body === "") throw new AgentDriverError(`${path}: body is empty`);
  return body;
}

interface ClaudePResponse {
  readonly result?: string;
  readonly is_error?: boolean;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}

function sumDefined(...values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, b) => a + b, 0);
}

function spawnClaude(
  claudeBin: string,
  args: readonly string[],
  prompt: string,
  timeoutMs: number,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number | null; readonly timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new AgentDriverError(`readability agent: claude binary not found: ${claudeBin} (set HBC2JS_CLAUDE_BIN, or pass --claude-bin)`));
        return;
      }
      reject(new AgentDriverError(`readability agent: spawn failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildMcpConfig(cliPath: string, opts: RunReadabilityAgentOpts): { readonly path: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-mcp-config-"));
  const path = join(dir, "mcp-config.json");
  const args = [cliPath, "mcp-server", opts.projectDir, ...(opts.hbc !== undefined ? ["--hbc", opts.hbc] : []), ...(opts.llmBackend !== undefined ? ["--llm-backend", opts.llmBackend] : [])];
  writeFileSync(path, JSON.stringify({ mcpServers: { hbc2js: { command: process.execPath, args } } }, null, 2));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Reads the SAME `ReadabilityContext` shape checkpoint (a)'s `mcp-server`
 *  builds (`buildReadabilityCtx`), for the driver's own before/after
 *  snapshot and end-of-run equivalence check -- this process never talks to
 *  the live MCP server the spawned `claude` process used (that server's
 *  lifecycle is scoped to `claude`'s own child process and is gone by the
 *  time this runs); it re-derives the same context and reads the state the
 *  run left on disk (the overlay sidecar, the `readability_tx` table). */
function buildDriverCtx(opts: RunReadabilityAgentOpts): ReadabilityContext | undefined {
  const dbFilePath = dbPath(opts.projectDir);
  const db = existsSync(dbFilePath) ? openProjectDb(dbFilePath) : undefined;
  return buildReadabilityCtx(db, opts.projectDir, {
    projectDir: opts.projectDir,
    ...(opts.hbc !== undefined ? { hbc: opts.hbc } : {}),
    ...(opts.llmBackend !== undefined ? { llmBackend: opts.llmBackend } : {}),
  })?.context;
}

function suggestionKey(item: SuggestionItem): string {
  return item.kind === "name" ? `name:${item.suggestionId}` : `tx:${item.tx.id}`;
}

/** Resolves the `.hbc` bytes the end-of-run equivalence check proves
 *  against. `project.hbcproj`'s `meta` table records the ORIGINAL bundle's
 *  sha256 (`bundle_sha256`, written by `hbc2js init`'s `buildIndexRows`)
 *  but never its filesystem path, and neither does `MODULES.json` -- so
 *  there is nothing to literally "derive" a path out of. `--hbc` is
 *  therefore REQUIRED (fail fast, before spawning anything, rather than
 *  the item-2 hand smoke's silent `INCONCLUSIVE` when it was omitted); when
 *  the project has a recorded hash, the supplied file is checked against it
 *  so a caller cannot accidentally point the equiv leg at the wrong bundle
 *  and get a confident-looking wrong answer. See PUSHBACK P-66. */
function resolveBundleHbc(opts: RunReadabilityAgentOpts): string {
  if (opts.hbc === undefined) {
    throw new AgentDriverError(
      "readability agent: --hbc <bundle.hbc> is required -- project.hbcproj records the source bundle's sha256 but not its filesystem path, so the end-of-run equivalence check has nothing to prove against without one (pass the same bundle 'hbc2js init' used)",
    );
  }
  const dbFilePath = dbPath(opts.projectDir);
  if (existsSync(dbFilePath)) {
    let db;
    try {
      db = openProjectDbReadonly(opts.projectDir);
    } catch {
      db = undefined;
    }
    if (db !== undefined) {
      try {
        const recorded = readMeta(db).get("bundle_sha256");
        if (recorded !== undefined) {
          const actual = sha256Hex(readFileSync(opts.hbc));
          if (actual !== recorded) {
            throw new AgentDriverError(
              `readability agent: --hbc ${opts.hbc} does not match this project (sha256 ${actual}, project.hbcproj recorded ${recorded} at init time) -- pass the same bundle 'hbc2js init' used`,
            );
          }
        }
      } finally {
        db.close();
      }
    }
  }
  return opts.hbc;
}

interface AgentSummary {
  readonly investigated?: readonly unknown[];
  readonly wrote?: readonly unknown[];
  readonly refusals?: readonly unknown[];
  readonly abstained?: readonly unknown[];
}

/** Parses the skill's `DONE\n{...}` output contract (`skills/hbc-agent.md`
 *  "Output contract"). Never throws: a reply that is not `DONE` at all --
 *  the real failure this queue item exists to catch, `max_turns` hit before
 *  a single tool call -- parses to `undefined`, same "abstain over crash"
 *  discipline `parseReadabilityResult` uses elsewhere in this lane. */
function parseAgentSummary(resultText: string): AgentSummary | undefined {
  const m = /^\s*DONE\s*\n([\s\S]*)$/.exec(resultText);
  if (m === null) return undefined;
  try {
    const parsed: unknown = JSON.parse((m[1] ?? "").trim());
    return typeof parsed === "object" && parsed !== null ? (parsed as AgentSummary) : undefined;
  } catch {
    return undefined;
  }
}

/** `investigated.length + wrote.length + refusals.length` -- every entry in
 *  any of those three arrays is one tool call the run itself reports
 *  making (read tools land in `investigated`, write/action tools in `wrote`
 *  or `refusals`). `abstained` entries are deliberate non-calls, not calls,
 *  so they are not counted. */
function countToolCalls(summary: AgentSummary | undefined): number {
  if (summary === undefined) return 0;
  const len = (v: readonly unknown[] | undefined): number => (Array.isArray(v) ? v.length : 0);
  return len(summary.investigated) + len(summary.wrote) + len(summary.refusals);
}

/** The end-of-run check this module owns: a tree-level equivalence pass
 *  over the project's readable `src/` tree, reusing `file-ops.ts`'s own
 *  `defaultTreeEquivOracle` rather than a second oracle -- scoped to the
 *  tree's declared entry module (`MODULES.json`'s `entry`, falling back to
 *  its first module) as a load-tolerant proxy for "every module the run
 *  touched" (enumerating exactly the touched modules is `written` diff's
 *  job upstream of this; this call proves the WHOLE tree the run could have
 *  touched still passes, not just the files it happened to write). */
function runEquivCheck(ctx: ReadabilityContext | undefined, hbc: string | undefined): TreeEquivResult | undefined {
  if (ctx === undefined) return undefined;
  const snapshot = readTree(ctx.treeDir);
  const index = readModulesIndex(snapshot);
  const entryId = index.entry ?? index.modules[0]?.id;
  const entryFile = index.modules.find((m) => m.id === entryId)?.file;
  if (entryFile === undefined) return undefined;
  return defaultTreeEquivOracle({ treeDir: ctx.treeDir, entry: entryFile, ...(hbc !== undefined ? { hbcPath: hbc } : {}) });
}

/** Runs one `hbc2js readability agent` invocation end to end. Never
 *  promotes anything -- `promote_change` is not among the tools the skill's
 *  own Rules permit the agent to call, and this driver calls no readability
 *  tool at all (its own reads are direct `listSuggestions`/tree-oracle
 *  calls, not MCP tool calls). */
export async function runReadabilityAgent(opts: RunReadabilityAgentOpts): Promise<AgentRunResult> {
  const prompt = goalPrompt(opts.scope);
  resolveBundleHbc(opts);
  const cliPath = opts.cliPath ?? join(import.meta.dirname, "..", "cli.ts");
  const claudeBin = opts.claudeBin ?? process.env["HBC2JS_CLAUDE_BIN"] ?? "claude";
  const model = opts.model ?? "haiku";
  const maxTurns = opts.maxTurns ?? 8;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const skillsDir = opts.skillsDir ?? join(import.meta.dirname, "..", "..", "skills");
  const skillBody = loadAgentSkillBody(skillsDir);

  const before = buildDriverCtx(opts);
  const beforeKeys = new Set(before !== undefined ? listSuggestions(before, {}).suggestions.map(suggestionKey) : []);

  const config = buildMcpConfig(cliPath, opts);
  try {
    const args = [
      "-p",
      "--model",
      model,
      "--mcp-config",
      config.path,
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__hbc2js__*",
      "--max-turns",
      String(maxTurns),
      "--output-format",
      "json",
      "--no-session-persistence",
      "--system-prompt",
      skillBody,
    ];
    const spawned = await spawnClaude(claudeBin, args, prompt, timeoutMs);
    if (spawned.timedOut) throw new AgentDriverError(`readability agent: claude timed out after ${String(timeoutMs)}ms`);

    let resultText = spawned.stdout;
    let usage: AgentRunResult["usage"] = {};
    try {
      const parsed = JSON.parse(spawned.stdout) as ClaudePResponse;
      resultText = parsed.result ?? spawned.stdout;
      const u = parsed.usage ?? {};
      const tokensIn = sumDefined(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens);
      usage = { ...(tokensIn !== undefined ? { tokensIn } : {}), ...(u.output_tokens !== undefined ? { tokensOut: u.output_tokens } : {}) };
    } catch {
      // A malformed/non-JSON reply is surfaced as-is (`resultText` stays the
      // raw stdout) rather than crashing the driver -- same "abstain over
      // crash" discipline `parseReadabilityResult` uses elsewhere.
    }

    const after = buildDriverCtx(opts);
    const written = after !== undefined ? listSuggestions(after, {}).suggestions.filter((item) => !beforeKeys.has(suggestionKey(item))) : [];
    const equiv = runEquivCheck(after, opts.hbc);
    const toolCalls = countToolCalls(parseAgentSummary(resultText));
    const exitCode = spawned.code !== 0 ? spawned.code : toolCalls === 0 ? 1 : 0;

    return { resultText, usage, exitCode, toolCalls, written, equiv };
  } finally {
    config.cleanup();
  }
}
