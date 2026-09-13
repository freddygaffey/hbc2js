// src/mcp/server.ts -- docs/lanes/readability.md queue item 1, checkpoint
// (a): a stdio JSON-RPC 2.0 MCP server exposing the EXISTING in-process
// tool table -- `src/mcp/tools.ts`'s spec-17 read/annotate tools plus the
// seven readability tools (`registerReadabilityTools`) -- over the
// transport spec 17 section 6 deferred ("the transport binding is a later
// round's decision"). Hand-rolled rather than an SDK dependency
// (package.json carries none, and the wire shape here is a small, fixed
// subset: initialize / tools/list / tools/call / resources/list /
// resources/read, newline-delimited JSON-RPC 2.0 on stdio) -- exactly the
// method set docs/lanes/readability.md's queue item 1a names.
//
// This file adds NO storage or gate logic of its own: every handler is a
// thin pass-through onto `McpResources`/`McpTools` (via `McpContext`) or
// onto `registerReadabilityTools`'s handler map, which is what actually
// enforces the read caps, the write-path truth rules, and the readability
// gate/refusal rules (`promoteChange`'s `worker:` refusal, `validate
// ReadabilityArgs`' schema checks, etc.) -- a caller reaching this server
// gets exactly those, no more, no less.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { McpContext } from "./context.ts";
import type { McpContextOpts } from "./context.ts";
import {
  READABILITY_TOOL_SCHEMAS,
  ReadabilityToolArgumentError,
  registerReadabilityTools,
  type AddCommentInput,
  type AddTagInput,
  type GenerateDocumentationInput,
  type JsonSchema,
  type PromoteInput,
  type RecompileEditInput,
  type RecordFindingInput,
  type RequestFidelityCheckInput,
  type SetFindingStatusInput,
  type SetNameInput,
} from "./tools.ts";
import { READABILITY_MCP_TOOLS } from "../readability/types.ts";
import type { ReadabilityContext } from "../readability/surfaces.ts";
import { ReadabilitySurfaceError } from "../readability/surfaces.ts";
import { Hbc2jsError } from "../errors.ts";
import { VERSION } from "../version.ts";

export interface McpServerOpts extends McpContextOpts {
  readonly readability?: ReadabilityContext;
}

export interface ToolDef {
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly handler: (args: unknown) => unknown;
}

export type ToolTable = Readonly<Record<string, ToolDef>>;

/** A hand-rolled JSON schema wide enough to admit any object -- used for the
 *  spec-17 write tools below, whose real argument shape (`Provenance`,
 *  `EvidenceRef[]`, ...) is nested well past what `JsonSchema`'s flat
 *  `type`/`properties`/`required`/`enum` subset (`src/mcp/tools.ts`) can
 *  express; the underlying `McpTools` method is still what actually
 *  validates and refuses a malformed call (surfaced to the caller as an
 *  `isError` tool result, never a silent no-op). */
const OBJECT_SCHEMA: JsonSchema = { type: "object", properties: {}, required: [] };

function fnSchema(extra?: Readonly<Record<string, { readonly type: string }>>): JsonSchema {
  return { type: "object", properties: { fn: { type: "number" }, ...extra }, required: ["fn"] };
}

function numberField(args: unknown, key: string): number {
  const v = (args as Record<string, unknown> | null | undefined)?.[key];
  if (typeof v !== "number") throw new Error(`${key} must be a number`);
  return v;
}

function stringField(args: unknown, key: string): string {
  const v = (args as Record<string, unknown> | null | undefined)?.[key];
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

/** The spec-17 READ resources (`McpResources`) a driving agent needs to
 *  "investigate with the read tools" (docs/lanes/readability.md queue item
 *  1b's own wording) before it ever writes anything -- a curated subset,
 *  not the whole of `resources.ts` (leads/security-sinks/scan/search-async
 *  stay out of scope this round, same line `src/mcp/tools.ts`'s own doc
 *  comment already draws). Every entry is a direct call onto the ONE
 *  `McpResources` instance `ctx` holds, so a read here is never stale
 *  relative to a write through this same server's write tools
 *  (`McpContext`'s own doc comment). */
function readTools(ctx: McpContext): ToolTable {
  const r = ctx.resources;
  return {
    get_context: {
      description: "Scoped decompiled context for one function: source, summary, xrefs, strings (the same shape the UI's context pane reads).",
      inputSchema: fnSchema(),
      handler: (args) => r.context(numberField(args, "fn")),
    },
    get_source: {
      description: "Decompiled source of one function.",
      inputSchema: fnSchema(),
      handler: (args) => r.source(numberField(args, "fn")),
    },
    get_disasm: {
      description: "Disassembly of one function.",
      inputSchema: fnSchema(),
      handler: (args) => r.disasm(numberField(args, "fn")),
    },
    who_calls: {
      description: "Callers of one function.",
      inputSchema: fnSchema(),
      handler: (args) => r.whoCalls(numberField(args, "fn")),
    },
    calls_from: {
      description: "Callees of one function.",
      inputSchema: fnSchema(),
      handler: (args) => r.callsFrom(numberField(args, "fn")),
    },
    search_functions: {
      description: "Search function names/signatures by substring.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: (args) => r.searchFunctions(stringField(args, "query")),
    },
    search_source: {
      description: "Search decompiled source text by substring.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: (args) => r.searchSource(stringField(args, "query")),
    },
    get_module: {
      description: "Module summary by id: its functions and their names.",
      inputSchema: { type: "object", properties: { module: { type: "number" } }, required: ["module"] },
      handler: (args) => r.module(numberField(args, "module")),
    },
  };
}

/** The spec-17 WRITE tools (`McpTools`) -- see `src/mcp/tools.ts`'s own
 *  header comment for the truth rules each one enforces (no fabricated
 *  finding, no self-confirm, the `tier` fold, `promote`'s rid/name
 *  exclusivity). Argument shapes are looser here (`OBJECT_SCHEMA`) than the
 *  readability tools below because the real shapes nest a `Provenance` /
 *  `EvidenceRef[]` past what this server's flat schema type can express --
 *  `McpTools` itself is still what refuses a malformed call. */
function writeTools(ctx: McpContext): ToolTable {
  const t = ctx.tools;
  return {
    set_name: { description: "Set a name for a binding (target: fn:N or reg:N:R).", inputSchema: OBJECT_SCHEMA, handler: (args) => t.setName(args as SetNameInput) },
    add_comment: { description: "Add a comment to a target.", inputSchema: OBJECT_SCHEMA, handler: (args) => t.addComment(args as AddCommentInput) },
    add_tag: { description: "Add a tag to a target.", inputSchema: OBJECT_SCHEMA, handler: (args) => t.addTag(args as AddTagInput) },
    record_finding: { description: "Record a finding (requires resolving evidence).", inputSchema: OBJECT_SCHEMA, handler: (args) => t.recordFinding(args as RecordFindingInput) },
    set_finding_status: { description: "Advance a finding's status (never self-confirming).", inputSchema: OBJECT_SCHEMA, handler: (args) => t.setFindingStatus(args as SetFindingStatusInput) },
    request_fidelity_check: { description: "Run the oracle ladder over one function's decompiled source.", inputSchema: OBJECT_SCHEMA, handler: (args) => t.requestFidelityCheck(args as RequestFidelityCheckInput) },
    recompile_edit: { description: "Compile an edited function's source to a scratch .hbc copy (writes a modified binary; never the original).", inputSchema: OBJECT_SCHEMA, handler: (args) => t.recompileEdit(args as RecompileEditInput) },
    generate_documentation: { description: "Render a report from this session's own log/findings.", inputSchema: OBJECT_SCHEMA, handler: (args) => t.generateDocumentation(args as GenerateDocumentationInput) },
    promote: { description: "Promote a 'suggested' name to accepted.", inputSchema: OBJECT_SCHEMA, handler: (args) => t.promote(args as PromoteInput) },
  };
}

/** The seven readability tools (spec 28 section 9.7), unchanged from
 *  `registerReadabilityTools` -- same schemas (`READABILITY_TOOL_SCHEMAS`),
 *  same argument validation (`validateReadabilityArgs`, run inside each
 *  handler before `surfaces.ts` ever sees the call), same refusals
 *  (`promoteChange`'s `worker:` gate, `ReadabilitySurfaceError`). This
 *  function adds nothing to that contract -- it only republishes the same
 *  handler map under this server's `ToolTable` shape. */
function readabilityTools(ctx: ReadabilityContext): ToolTable {
  const handlers = registerReadabilityTools(ctx);
  const out: Record<string, ToolDef> = {};
  for (const tool of READABILITY_MCP_TOOLS) {
    out[tool] = {
      description: `Readability surface: ${tool} (spec 28 section 9.7).`,
      inputSchema: READABILITY_TOOL_SCHEMAS[tool],
      handler: handlers[tool],
    };
  }
  return out;
}

/** Builds the whole tool table this server answers `tools/list`/`tools/call`
 *  with: the spec-17 read+write tools, always; the seven readability tools
 *  only when a `ReadabilityContext` is given (a project with no readable
 *  `src/` tree, or a bad `--llm-backend`, gets the read/write half only --
 *  same "absent, not faked" convention `buildReadabilityCtx`
 *  (`src/ui-server/server.ts`) already uses for the ui-server's own routes). */
export function buildToolTable(ctx: McpContext, readability?: ReadabilityContext): ToolTable {
  return { ...readTools(ctx), ...writeTools(ctx), ...(readability !== undefined ? readabilityTools(readability) : {}) };
}

// --- JSON-RPC 2.0 dispatch ---------------------------------------------------

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function toolsListResult(table: ToolTable): unknown {
  return { tools: Object.entries(table).map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema })) };
}

/** A tool THROWING (a gate refusal, a bad-shape argument,
 *  `ReadabilityToolArgumentError`, `ReadabilitySurfaceError`, `Hbc2jsError`,
 *  or any other error `surfaces.ts`/`McpTools` raises) is reported as an
 *  MCP `isError` TOOL RESULT, never a JSON-RPC protocol error -- the normal
 *  MCP convention (a tool call that fails is still a successful RPC) and
 *  what lets a driving agent read the refusal text and adapt, rather than
 *  the transport itself erroring out from under it. */
async function callTool(
  table: ToolTable,
  params: unknown,
): Promise<{ readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly isError?: boolean }> {
  const p = params as { readonly name?: unknown; readonly arguments?: unknown } | undefined;
  const name = p?.name;
  if (typeof name !== "string" || table[name] === undefined) {
    return { content: [{ type: "text", text: `unknown tool: ${String(name)}` }], isError: true };
  }
  try {
    // A handler may be async (`request_fidelity_check`) or sync (everything
    // else); `Promise.resolve` makes both paths the same without every
    // handler needing to know which it is.
    const result = await Promise.resolve(table[name]?.handler(p?.arguments ?? {}));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) {
    const message =
      e instanceof ReadabilityToolArgumentError || e instanceof ReadabilitySurfaceError || e instanceof Hbc2jsError || e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Republishes every read tool as a spec-17 §6-deferred RESOURCE too (`hbc2js://<name>[?query]`,
 *  the query string standing in for the args a bare `{uri}` resources/read
 *  request has no other field for) -- most MCP-aware callers reach these
 *  through `tools/call` in practice (that is the whole of what the
 *  checkpoint-b driver's `--allowedTools "mcp__hbc2js__*"` grants), so this
 *  is deliberately the READ half only, kept thin. */
function resourcesListResult(table: ToolTable, readNames: readonly string[]): unknown {
  return { resources: readNames.filter((n) => table[n] !== undefined).map((name) => ({ uri: `hbc2js://${name}`, name, description: table[name]?.description })) };
}

function readResource(table: ToolTable, params: unknown): unknown {
  const p = params as { readonly uri?: unknown } | undefined;
  const uri = p?.uri;
  if (typeof uri !== "string" || !uri.startsWith("hbc2js://")) throw new Error(`resources/read: bad uri ${String(uri)}`);
  const rest = uri.slice("hbc2js://".length);
  const q = rest.indexOf("?");
  const name = q < 0 ? rest : rest.slice(0, q);
  const def = table[name];
  if (def === undefined) throw new Error(`resources/read: unknown resource ${name}`);
  const args: Record<string, unknown> = {};
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(rest.slice(q + 1))) {
      args[k] = /^-?\d+$/.test(v) ? Number(v) : v;
    }
  }
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(def.handler(args)) }] };
}

const READ_RESOURCE_NAMES = ["get_context", "get_source", "get_disasm", "who_calls", "calls_from", "search_functions", "search_source", "get_module"] as const;

/** Handles exactly one JSON-RPC request against a built tool table --
 *  separated from the stdio loop below so the round-trip test can drive it
 *  in-process with a plain object, no child process, no pipes. A
 *  notification (`id` absent) has no response under JSON-RPC 2.0; callers
 *  that read `req.id === undefined` before calling this (the stdio loop
 *  does) never call it for one at all. */
export async function handleRequest(table: ToolTable, req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "initialize":
        return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "hbc2js", version: VERSION }, capabilities: { tools: {}, resources: {} } } };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: toolsListResult(table) };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await callTool(table, req.params) };
      case "resources/list":
        return { jsonrpc: "2.0", id, result: resourcesListResult(table, READ_RESOURCE_NAMES) };
      case "resources/read":
        return { jsonrpc: "2.0", id, result: readResource(table, req.params) };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } };
  }
}

/** The stdio transport: one JSON-RPC 2.0 object per line, in and out
 *  (never a shell, never argv -- same "prompt on stdin" discipline
 *  `claude-cli.ts` already uses for a different reason, blowing `ARG_MAX`).
 *  A line that fails to parse gets a `-32700 parse error` response rather
 *  than crashing the process; a notification (no `id`) is processed for its
 *  side effect (currently none are defined) with no reply, per JSON-RPC 2.0. */
export interface ServeMcpStdioOpts {
  /** Calls `process.exit(0)` once stdin closes AND every in-flight request
   *  has answered -- correct for the real CLI process (a driver that closes
   *  the child's stdin, or kills it, is the only "shutdown" signal a stdio
   *  transport gets), wrong for an in-process test that hands this function
   *  a `PassThrough` and would otherwise take the whole test worker down
   *  with it. Default `false`; `hbc2js mcp-server` (`src/cli.ts`) turns it
   *  on. */
  readonly exitOnClose?: boolean;
}

export function serveMcpStdio(table: ToolTable, input: Readable = process.stdin, output: Writable = process.stdout, opts: ServeMcpStdioOpts = {}): void {
  const rl = createInterface({ input, terminal: false });
  let pending = 0;
  let closed = false;
  const maybeExit = (): void => {
    if (closed && pending === 0 && opts.exitOnClose === true) process.exit(0);
  };
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    if (req.id === undefined) return;
    pending += 1;
    void handleRequest(table, req)
      .then((res) => {
        output.write(`${JSON.stringify(res)}\n`);
      })
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
  });
  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
}
