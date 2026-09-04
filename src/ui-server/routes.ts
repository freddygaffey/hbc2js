// src/ui-server/routes.ts — docs/specs/22-ui-mvp.md §3 `src/ui-server/`
// (this task's own §3.5 table lists every route -> class method mapping).
//
// A PURE function, `handle()`: no `node:http` here, so this file is
// unit-testable without a socket (server.ts is the thin http binding over
// it). Every route is a direct call into the existing transport-agnostic
// MCP classes (`src/mcp/resources.ts`'s `McpResources`, `src/mcp/tools.ts`'s
// `McpTools`) or this layer's own bounded list helpers (`list.ts`, for the
// two whole-catalogue reads spec 17 §14 deliberately cut from
// `resources.ts`). Every response that wraps a `Bounded<T>`/`SearchPage<T>`
// result carries the SAME `total`/`truncated`(/`nextCursor`) fields the
// class already computed — this file never re-derives or widens a cap.
import type { McpResources } from "../mcp/resources.ts";
import type { McpTools } from "../mcp/tools.ts";
import { Hbc2jsError } from "../errors.ts";
import { listModules, listFunctions, moduleSource } from "./list.ts";
import { segregation } from "./segregation.ts";
import { WORKER_ROUTES, type WorkersCtx } from "./workers-routes.ts";

export interface UiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface UiResponse {
  readonly status: number;
  readonly json: unknown;
}

export interface UiServerCtx {
  // `resources`/`tools` share ONE `ArtifactService`/`ProjectService` pair
  // (docs/specs/17-mcp-harness.md §15's `McpContext`, `src/mcp/context.ts`)
  // — a write through `tools` reloads that shared `ProjectService`'s own
  // in-memory caches (`reloadFromDb()`), so `resources`'s next read sees it
  // immediately. `server.ts` builds `ctx` from one `McpContext` and no
  // longer rebuilds either field after a write (§15 deleted that
  // workaround, the old comment here described it); `handle()` itself
  // never assigns either.
  readonly resources: McpResources;
  readonly tools: McpTools;
  /** `McpResources`/`ArtifactService` both keep their own `artifactDir`
   *  private (it's an implementation detail of the class, not part of
   *  either's public surface) — this layer's own `list.ts` helpers need
   *  the raw path for `hasProjectDb`/`index/modules.json`, so the ctx that
   *  builds `McpResources` carries it alongside, not re-derived. */
  readonly artifactDir: string;
  /** The spec-23 worker surface (queue, presence, event feed, runner), built
   *  by `server.ts` when workers are enabled. `undefined` = this server runs
   *  without workers (`--workers off`, or a project with no DB); every
   *  `/api/jobs|sessions|worker-events|suggestions` route then answers 503
   *  rather than an empty list. */
  readonly workers?: WorkersCtx;
}

function ok(json: unknown): UiResponse {
  return { status: 200, json };
}

function badRequest(reason: string): UiResponse {
  return { status: 400, json: { reason } };
}

function notFound(reason: string): UiResponse {
  return { status: 404, json: { reason } };
}

function qBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === "1" || v === "true";
}

function qNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function qCsv(v: string | undefined): readonly string[] | undefined {
  if (v === undefined || v === "") return undefined;
  return v.split(",");
}

function parseFn(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

type Handler = (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;

interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: Handler;
}

const BASE_ROUTES: readonly Route[] = [
  // -- fn / source / disasm / context / xrefs / annotations (spec 17 §1, §14) --
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)$/,
    handler: ([raw], _req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}: not a function index`);
      return ok(ctx.resources.fn(fn));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/source$/,
    handler: ([raw], req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/source: not a function index`);
      const linesRaw = req.query.lines;
      let lines: readonly [number, number] | undefined;
      if (linesRaw !== undefined) {
        const parts = linesRaw.split(",").map(Number);
        if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return badRequest(`fn/${raw}/source: ?lines=a,b must be two numbers`);
        lines = [parts[0]!, parts[1]!];
      }
      return ok(ctx.resources.source(fn, lines !== undefined ? { lines } : {}));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/disasm$/,
    handler: ([raw], _req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/disasm: not a function index`);
      return ok(ctx.resources.disasm(fn));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/context$/,
    handler: ([raw], req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/context: not a function index`);
      const include = qCsv(req.query.include) as readonly ("metadata" | "source" | "callers" | "callees" | "strings")[] | undefined;
      const depth = qNum(req.query.depth);
      return ok(ctx.resources.context(fn, { ...(include !== undefined ? { include } : {}), ...(depth !== undefined ? { depth } : {}) }));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/callers$/,
    handler: ([raw], req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/callers: not a function index`);
      const all = qBool(req.query.all);
      return ok(ctx.resources.whoCalls(fn, all !== undefined ? { all } : {}));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/callees$/,
    handler: ([raw], req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/callees: not a function index`);
      const all = qBool(req.query.all);
      return ok(ctx.resources.callsFrom(fn, all !== undefined ? { all } : {}));
    },
  },
  {
    method: "GET",
    re: /^\/api\/fn\/([^/]+)\/annotations$/,
    handler: ([raw], req, ctx) => {
      const fn = parseFn(raw!);
      if (fn === null) return badRequest(`fn/${raw}/annotations: not a function index`);
      const all = qBool(req.query.all);
      return ok(ctx.resources.annotationsForFn(fn, all !== undefined ? { all } : {}));
    },
  },
  // -- module (spec 17 §1/§14: DIRECT edges only, own list added by this layer) --
  {
    method: "GET",
    re: /^\/api\/module\/([^/]+)$/,
    handler: ([raw], _req, ctx) => {
      const id = parseFn(raw!);
      if (id === null) return badRequest(`module/${raw}: not a module id`);
      return ok(ctx.resources.module(id));
    },
  },
  {
    method: "GET",
    re: /^\/api\/module\/([^/]+)\/source$/,
    handler: ([raw], _req, ctx) => {
      const id = parseFn(raw!);
      if (id === null) return badRequest(`module/${raw}/source: not a module id`);
      const r = moduleSource(ctx.resources.artifact, id);
      if (r === null) return { status: 404, json: { reason: `module ${id}: no source file recorded` } };
      return ok(r);
    },
  },
  {
    method: "GET",
    re: /^\/api\/modules$/,
    handler: (_p, _req, ctx) => ok(listModules(ctx.artifactDir)),
  },
  {
    // The name-recovered tree (`segregation.ts`): computed once per server
    // process, then served from that file's cache.
    method: "GET",
    re: /^\/api\/segregation$/,
    handler: (_p, _req, ctx) => {
      const r = segregation(ctx);
      if (r === null) return notFound("segregation: this project has no module_<id>.js files to segregate");
      return ok(r);
    },
  },
  {
    method: "GET",
    re: /^\/api\/functions$/,
    handler: (_p, req, ctx) => ok(listFunctions(ctx.resources.artifact, qNum(req.query.cursor) ?? 0)),
  },
  // -- search (spec 17 §14 addition 3) --
  {
    method: "GET",
    re: /^\/api\/search\/functions$/,
    handler: (_p, req, ctx) => {
      const q = req.query.q;
      if (q === undefined) return badRequest("search/functions: ?q= is required");
      const regex = qBool(req.query.regex);
      const cursor = qNum(req.query.cursor);
      return ok(ctx.resources.searchFunctions(q, { ...(regex !== undefined ? { regex } : {}), ...(cursor !== undefined ? { cursor } : {}) }));
    },
  },
  {
    method: "GET",
    re: /^\/api\/search\/source$/,
    handler: (_p, req, ctx) => {
      const q = req.query.q;
      if (q === undefined) return badRequest("search/source: ?q= is required");
      const regex = qBool(req.query.regex);
      const cursor = qNum(req.query.cursor);
      return ok(ctx.resources.searchSource(q, { ...(regex !== undefined ? { regex } : {}), ...(cursor !== undefined ? { cursor } : {}) }));
    },
  },
  // -- xref (spec 17 §1/§14) --
  {
    method: "GET",
    re: /^\/api\/xref\/string$/,
    handler: (_p, req, ctx) => {
      const mode = (req.query.mode ?? "exact") as "exact" | "substring" | "regex";
      if (mode !== "exact" && mode !== "substring" && mode !== "regex") return badRequest(`xref/string: bad mode ${mode}`);
      const rawKey = req.query.key;
      if (rawKey === undefined) return badRequest("xref/string: ?key= is required");
      const key: number | string = mode === "exact" ? Number(rawKey) : rawKey;
      if (mode === "exact" && !Number.isFinite(key)) return badRequest("xref/string: mode=exact needs a numeric ?key=");
      return ok(ctx.resources.xrefString(key, mode));
    },
  },
  {
    method: "GET",
    re: /^\/api\/xref\/global$/,
    handler: (_p, req, ctx) => {
      const name = req.query.name;
      if (name === undefined) return badRequest("xref/global: ?name= is required");
      const all = qBool(req.query.all);
      return ok(ctx.resources.globalUses(name, all !== undefined ? { all } : {}));
    },
  },
  // -- native / leads / findings / scan (spec 17 §1/§14) --
  {
    method: "GET",
    re: /^\/api\/native$/,
    handler: (_p, req, ctx) => {
      const fn = qNum(req.query.fn);
      const all = qBool(req.query.all);
      return ok(ctx.resources.native({ ...(fn !== undefined ? { fn } : {}), ...(all !== undefined ? { all } : {}) }));
    },
  },
  { method: "GET", re: /^\/api\/leads$/, handler: (_p, _req, ctx) => ok(ctx.resources.leads()) },
  { method: "GET", re: /^\/api\/leads\/security-sinks$/, handler: (_p, _req, ctx) => ok(ctx.resources.securitySinks()) },
  {
    method: "GET",
    re: /^\/api\/findings$/,
    handler: (_p, req, ctx) => {
      const tag = req.query.tag as import("../project/schema.ts").Tag | undefined;
      const severity = req.query.severity as import("../project/schema.ts").Severity | undefined;
      const status = req.query.status as import("../project/schema.ts").FindingStatus | undefined;
      const all = qBool(req.query.all);
      return ok(
        ctx.resources.findings(
          { ...(tag !== undefined ? { tag } : {}), ...(severity !== undefined ? { severity } : {}), ...(status !== undefined ? { status } : {}) },
          all !== undefined ? { all } : {},
        ),
      );
    },
  },
  {
    method: "GET",
    re: /^\/api\/finding\/([^/]+)$/,
    handler: ([raw], _req, ctx) => {
      const rid = decodeURIComponent(raw!);
      const f = ctx.resources.finding(rid);
      if (f === null) return notFound(`finding/${rid}: no such finding`);
      return ok(f);
    },
  },
  { method: "GET", re: /^\/api\/scan\/secrets$/, handler: (_p, _req, ctx) => ok(ctx.resources.scanSecrets()) },
  // -- log / history (spec 16 §3.2, spec 21 live feed) --
  {
    method: "GET",
    re: /^\/api\/log$/,
    handler: (_p, req, ctx) => {
      const since = req.query.since;
      const who = req.query.who;
      const all = qBool(req.query.all);
      return ok(ctx.resources.log({ ...(since !== undefined ? { since } : {}), ...(who !== undefined ? { who } : {}) }, all !== undefined ? { all } : {}));
    },
  },
  {
    method: "GET",
    re: /^\/api\/log\/tail$/,
    handler: (_p, req, ctx) => ok(tailLog(ctx.resources, qNum(req.query.since) ?? 0)),
  },
  {
    method: "GET",
    re: /^\/api\/history\/([^/]+)$/,
    handler: ([raw], req, ctx) => {
      const target = decodeURIComponent(raw!);
      const all = qBool(req.query.all);
      return ok(ctx.resources.history(target, all !== undefined ? { all } : {}));
    },
  },
  // -- write tools (spec 17 §2/§14, POST body = the tool's Input interface) --
  { method: "POST", re: /^\/api\/tools\/set-name$/, handler: (_p, req, ctx) => ok(ctx.tools.setName(req.body as Parameters<McpTools["setName"]>[0])) },
  { method: "POST", re: /^\/api\/tools\/add-comment$/, handler: (_p, req, ctx) => ok(ctx.tools.addComment(req.body as Parameters<McpTools["addComment"]>[0])) },
  { method: "POST", re: /^\/api\/tools\/add-tag$/, handler: (_p, req, ctx) => ok(ctx.tools.addTag(req.body as Parameters<McpTools["addTag"]>[0])) },
  { method: "POST", re: /^\/api\/tools\/record-finding$/, handler: (_p, req, ctx) => ok(ctx.tools.recordFinding(req.body as Parameters<McpTools["recordFinding"]>[0])) },
  {
    method: "POST",
    re: /^\/api\/tools\/set-finding-status$/,
    handler: (_p, req, ctx) => ok(ctx.tools.setFindingStatus(req.body as Parameters<McpTools["setFindingStatus"]>[0])),
  },
  {
    method: "POST",
    re: /^\/api\/tools\/request-fidelity-check$/,
    handler: async (_p, req, ctx) => ok(await ctx.tools.requestFidelityCheck(req.body as Parameters<McpTools["requestFidelityCheck"]>[0])),
  },
  {
    method: "POST",
    re: /^\/api\/tools\/generate-documentation$/,
    handler: (_p, req, ctx) => ok(ctx.tools.generateDocumentation((req.body ?? {}) as Parameters<McpTools["generateDocumentation"]>[0])),
  },
  {
    // §13's warning/watermark travel verbatim — this handler does not touch
    // the result shape at all, just forwards `RecompileEditResult` as-is.
    method: "POST",
    re: /^\/api\/tools\/recompile-edit$/,
    handler: (_p, req, ctx) => ok(ctx.tools.recompileEdit(req.body as Parameters<McpTools["recompileEdit"]>[0])),
  },
];

/** One table, two files: the spec-22 routes above plus the spec-23 worker
 *  routes (`workers-routes.ts`, which owns their doc comments). `handle()`
 *  below still walks a single list, so there is exactly one place a request
 *  can 404. */
const ROUTES: readonly Route[] = [...BASE_ROUTES, ...WORKER_ROUTES];

/** `/api/log/tail?since=<seq>` — spec 21 §1.3's "read log entries after its
 *  cursor" half of the doorbell pairing (this MVP does poll only, §1
 *  default; see `server.ts`'s `/api/events` for the SSE convenience
 *  wrapper over the same read). `since` is the last `seq` the caller has
 *  already applied (0 the first time); `McpResources.log`'s own `since` is
 *  a timestamp string with a `>=` (inclusive) comparison, the wrong shape
 *  for a "give me only what's new" tail, so this reads the FULL log
 *  (`ProjectService.log({}, {all:true})`, uncapped — this endpoint's own
 *  job is exactly to be complete over new rows, not to sample) and filters
 *  by `seq > since` itself, returning rows OLDEST-first (the natural order
 *  to append to a growing feed) plus `cursor`, the highest `seq` returned
 *  (or the input `since` if nothing was new) for the next poll. */
export interface LogTailResult {
  readonly rows: readonly { readonly seq: number; readonly ts: string; readonly who: string; readonly op: string; readonly detail: string | null }[];
  readonly cursor: number;
}

const LOG_TAIL_CAP = 500;

export function tailLog(resources: McpResources, since: number): LogTailResult {
  const all = resources.project.log({}, { all: true }).rows;
  const fresh = all.filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
  const rows = fresh.slice(0, LOG_TAIL_CAP);
  const cursor = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
  return { rows, cursor };
}

/** Every `/api/tools/*` route that actually mutates project state (mints a
 *  `log`/`revisions` row) — `request-fidelity-check` and
 *  `generate-documentation` are pure reads/computations and are excluded.
 *  §15's `McpContext` (`UiServerCtx.resources`'s own doc comment) made the
 *  "does `server.ts` need to rebuild `ctx.resources` after this?" question
 *  this set used to answer moot — kept as the still-useful "which tool
 *  routes are writes" classification (e.g. for a future audit/log use). */
export const WRITE_TOOL_PATHS: ReadonlySet<string> = new Set([
  "/api/tools/set-name",
  "/api/tools/add-comment",
  "/api/tools/add-tag",
  "/api/tools/record-finding",
  "/api/tools/set-finding-status",
  "/api/tools/recompile-edit",
]);

export async function handle(req: UiRequest, ctx: UiServerCtx): Promise<UiResponse> {
  const path = req.path;
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;
    const m = route.re.exec(path);
    if (m === null) continue;
    try {
      return await route.handler(m.slice(1), req, ctx);
    } catch (e) {
      if (e instanceof Hbc2jsError) return badRequest(e.message);
      return { status: 500, json: { reason: e instanceof Error ? e.message : String(e) } };
    }
  }
  return notFound(`no such route: ${req.method} ${path}`);
}
