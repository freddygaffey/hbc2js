// src/ui-server/readability-routes.ts -- spec 28 landing 4c: the HTTP surface
// over `src/readability/surfaces.ts` (the same functions the MCP tools call,
// `src/mcp/tools.ts`), spliced into `routes.ts`'s table exactly like
// `workers-routes.ts`'s `WORKER_ROUTES` is. Pure functions over a ctx, no
// `node:http`, so every route is unit-testable without a socket.
//
// `list_suggestions`/`promote_change`/`revert_change` (below) still call
// straight into `src/readability/surfaces.ts`, same as landing 4c: they are
// reads or single-record writes with nothing worth polling for. The three
// WRITE-capable UI actions -- `suggest-names`/`rewrite-function`/
// `combine-files` -- are DIFFERENT (spec 28 landing 4d, PUSHBACK P-61
// resolved): they now ENQUEUE through the SAME `JobQueue`/`WorkerRunner`
// spec 23's `/api/jobs` uses (`JOB_KINDS` gained a `readability-*` triple,
// `WorkerRunner.runReadabilityJob` dispatches them to the surfaces), and
// answer `{jobId}` for the pane to poll via the ordinary jobs rail, rather
// than blocking the HTTP response on a potentially slow surface call (a
// cold `suggest_names`/`rewrite_function` re-parses and re-analyses the
// WHOLE bytecode file with no cache -- `docs/BUGS.md`, filed alongside this
// change). `review` (section 9.7: "opens the queue; no job") is unchanged,
// still synchronous -- there is nothing to enqueue for it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listSuggestions,
  promoteChange,
  revertChange,
  ReadabilitySurfaceError,
  type ListSuggestionsFilter,
  type ReadabilityContext,
  type SuggestionItem,
} from "../readability/surfaces.ts";
import { TransactionRefused } from "../readability/transactions.ts";
import { FileOpError } from "../readability/file-ops.ts";
import { readBlob } from "../projdb/readability-shards.ts";
import type { UiRequest, UiResponse } from "./routes.ts";
import type { WorkersCtx } from "./workers-routes.ts";

/** Hung off `UiServerCtx.readability` (undefined = this server was started
 *  against a project with no readable tree / no configured backend, same
 *  "absent, not faked" convention `WorkersCtx` uses). `backendId` is the
 *  configured default backend's own `.id` (spec 28 landing 1b: `claude-cli`
 *  once that backend lands; never hardcoded here) -- reported back to the
 *  UI the same way `WorkersCtx.backendId` is, so "why is this name so
 *  literal" has a visible answer for readability jobs too. */
export interface ReadabilityRoutesCtx {
  readonly context: ReadabilityContext;
  readonly backendId: string;
}

interface RCtx {
  readonly readability?: ReadabilityRoutesCtx;
  /** Spec 28 landing 4d: the three write actions enqueue through the SAME
   *  pool `workers-routes.ts` uses -- `undefined` (workers off / no
   *  `.hbcproj`) means there is nowhere to enqueue into, even when
   *  `readability` itself is configured. */
  readonly workers?: WorkersCtx;
}

type Handler = (params: readonly string[], req: UiRequest, ctx: RCtx) => UiResponse | Promise<UiResponse>;

interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: Handler;
}

function ok(json: unknown): UiResponse {
  return { status: 200, json };
}
function badRequest(reason: string): UiResponse {
  return { status: 400, json: { reason } };
}

/** Same absence convention as `workers-routes.ts`'s `noWorkers()`: the
 *  server ran with no readable tree / no readability backend configured, so
 *  the honest answer is "not here", not an empty list. */
function noReadability(): UiResponse {
  return { status: 503, json: { reason: "readability is not configured on this server (no readable tree / backend)" } };
}

/** Spec 28 landing 4d: a write action has somewhere to run the surface
 *  (`readability` configured) but nowhere to QUEUE it (`--workers off` /
 *  no `.hbcproj`) -- a different, equally honest 503 from `noReadability`'s. */
function noWorkersForReadability(): UiResponse {
  return { status: 503, json: { reason: "readability actions need the worker pool (--workers off, or no .hbcproj)" } };
}

function accepted(json: unknown): UiResponse {
  return { status: 202, json };
}

function body(req: UiRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** Every route below lands here: `ReadabilitySurfaceError` and
 *  `TransactionRefused` are the surfaces' own "your request is malformed / a
 *  gate refused it" signals (never a 500 -- both are expected, reportable
 *  outcomes, same as `FileOpError`), everything else rethrows for `handle()`
 *  to turn into a 500. */
async function guarded(run: () => UiResponse | Promise<UiResponse>): Promise<UiResponse> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ReadabilitySurfaceError) return badRequest(e.message);
    if (e instanceof TransactionRefused) return { status: 409, json: { reason: e.message, problems: e.problems } };
    if (e instanceof FileOpError) return badRequest(e.message);
    throw e;
  }
}

function qBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  return v === "1" || v === "true";
}
function qNum(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function filterFromQuery(req: UiRequest): ListSuggestionsFilter {
  const tier = req.query["tier"];
  const confidence = req.query["confidence"];
  const module = qNum(req.query["module"]);
  const securityRelevant = qBool(req.query["securityRelevant"]);
  return {
    ...(tier === "suggested" || tier === "confirmed" ? { tier } : {}),
    ...(confidence === "low" || confidence === "med" || confidence === "high" ? { confidence } : {}),
    ...(module !== undefined ? { module } : {}),
    // 2026-09-11 (landing 4d, docs/BUGS.md resolved): `listSuggestions`
    // applies this to name suggestions (`NameRecord.securityRelevant`, from
    // `NamePassTarget.securityRelevant`) -- a `ReadabilityTransaction`
    // (rewrite/file-op) still carries no such field, so it is a no-op over
    // those items, same precedent as the `confidence` filter above.
    ...(securityRelevant !== undefined ? { securityRelevant } : {}),
  };
}

/** Best-effort current bytes for an emitted path -- `undefined` (never a
 *  thrown error) when the file is gone, which the panel should treat the
 *  same as "no new content to show" rather than a 500. */
function readCurrentTreeFile(treeDir: string, path: string): string | undefined {
  try {
    return readFileSync(join(treeDir, path), "utf8");
  } catch {
    return undefined;
  }
}

/** Spec 28 landing 4d ("diff content", docs/BUGS.md resolved): the before/
 *  after panel needs RENDERED TEXT, not just the `prior.files[].sha256`/
 *  `EmittedFile.path` the transaction shape (`types.ts`) already carries
 *  (deliberately unchanged here, per the brief -- this is route-response-only
 *  enrichment). `priorContent` reads the exact bytes the transaction log
 *  already stores for `revert` (`readBlob`, keyed by the recorded sha256);
 *  `newContent` reads whatever `treeDir` currently holds at each output path
 *  (the accepted rewrite's own write, `surfaces.ts`'s `rewriteFunction`) --
 *  both keyed by path, both omitted (not empty-string) when unavailable. A
 *  `name` suggestion has no tree file at all, so it is returned unchanged. */
function withDiffContent(r: ReadabilityRoutesCtx, item: SuggestionItem): SuggestionItem {
  if (item.kind !== "tx") return item;
  const priorContent: Record<string, string> = {};
  for (const f of item.tx.prior.files) {
    const content = readBlob(r.context.db, f.sha256);
    if (content !== undefined) priorContent[f.path] = content;
  }
  const newContent: Record<string, string> = {};
  for (const o of item.tx.outputs) {
    const content = readCurrentTreeFile(r.context.treeDir, o.path);
    if (content !== undefined) newContent[o.path] = content;
  }
  return { ...item, priorContent, newContent } as SuggestionItem;
}

export const READABILITY_ROUTES: readonly Route[] = [
  {
    method: "GET",
    re: /^\/api\/readability\/suggestions$/,
    handler: (_p, req, ctx) => {
      const r = ctx.readability;
      if (r === undefined) return noReadability();
      const limit = qNum(req.query["limit"]);
      const filter = filterFromQuery(req);
      const result = listSuggestions(r.context, { filter, ...(limit !== undefined ? { limit } : {}) });
      return ok({ ...result, suggestions: result.suggestions.map((s) => withDiffContent(r, s)), backend: r.backendId });
    },
  },
  {
    method: "POST",
    re: /^\/api\/readability\/promote$/,
    handler: (_p, req, ctx) =>
      guarded(() => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
        const b = body(req);
        const txId = b["txId"];
        const suggestionId = b["suggestionId"];
        const who = b["who"];
        if (typeof who !== "string" || who === "") return badRequest("readability/promote: who is required");
        if (typeof txId !== "string" && typeof suggestionId !== "string") {
          return badRequest("readability/promote: one of txId|suggestionId is required");
        }
        return ok(
          promoteChange(r.context, {
            who,
            ...(typeof txId === "string" ? { txId } : {}),
            ...(typeof suggestionId === "string" ? { suggestionId } : {}),
          }),
        );
      }),
  },
  {
    method: "POST",
    re: /^\/api\/readability\/revert$/,
    handler: (_p, req, ctx) =>
      guarded(() => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
        const b = body(req);
        const txId = b["txId"];
        const suggestionId = b["suggestionId"];
        if (typeof txId !== "string" && typeof suggestionId !== "string") {
          return badRequest("readability/revert: one of txId|suggestionId is required");
        }
        return ok(
          revertChange(r.context, {
            ...(typeof txId === "string" ? { txId } : {}),
            ...(typeof suggestionId === "string" ? { suggestionId } : {}),
          }),
        );
      }),
  },
  // -- three of the four spec 28 section 9.7 UI actions: ENQUEUED (spec 28
  // landing 4d, P-61 resolved) -- `review` (below) has nothing to enqueue
  // and stays synchronous. Each handler validates the shape (a malformed
  // request never reaches the queue), then `enqueue`s a `readability-*`
  // job and answers 202 `{jobId}` for the pane to poll via `/api/jobs`,
  // same convention `workers-routes.ts`'s own `POST /api/jobs` uses. -----
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/suggest-names$/,
    handler: (_p, req, ctx) => {
      const r = ctx.readability;
      if (r === undefined) return noReadability();
      if (ctx.workers === undefined) return noWorkersForReadability();
      const b = body(req);
      const module = b["module"];
      const fn = b["fn"];
      if (typeof module !== "number" && typeof fn !== "number") {
        return badRequest("readability/actions/suggest-names: one of {module}|{fn} is required");
      }
      const input = typeof fn === "number" ? { fn } : { module: module as number };
      const { job } = ctx.workers.queue.enqueue({ kind: "readability-suggest-names", input });
      return accepted({ jobId: job.id, status: job.status });
    },
  },
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/rewrite-function$/,
    handler: (_p, req, ctx) => {
      const r = ctx.readability;
      if (r === undefined) return noReadability();
      if (ctx.workers === undefined) return noWorkersForReadability();
      const b = body(req);
      const fn = b["fn"];
      if (typeof fn !== "number") return badRequest("readability/actions/rewrite-function: fn is required");
      const { job } = ctx.workers.queue.enqueue({ kind: "readability-rewrite-function", input: { fn } });
      return accepted({ jobId: job.id, status: job.status });
    },
  },
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/combine-files$/,
    handler: (_p, req, ctx) => {
      const r = ctx.readability;
      if (r === undefined) return noReadability();
      if (ctx.workers === undefined) return noWorkersForReadability();
      const b = body(req);
      const inputs = b["inputs"];
      const outputs = b["outputs"];
      const evidence = b["evidence"];
      if (!Array.isArray(inputs) || inputs.length < 2 || !inputs.every((p) => typeof p === "string")) {
        return badRequest("readability/actions/combine-files: inputs must be at least two file paths");
      }
      if (!Array.isArray(outputs) || outputs.length !== 1 || typeof outputs[0] !== "string") {
        return badRequest("readability/actions/combine-files: outputs must be exactly one file path (combine has one target)");
      }
      if (typeof evidence !== "string" || evidence === "") return badRequest("readability/actions/combine-files: evidence is required");
      const { job } = ctx.workers.queue.enqueue({ kind: "readability-combine-files", input: { inputs, outputs, evidence } });
      return accepted({ jobId: job.id, status: job.status });
    },
  },
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/review$/,
    handler: (_p, _req, ctx) =>
      guarded(() => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
        // "opens the queue; no job" (spec 28 §9.7, brief-l4c-pane): review has
        // nothing to enqueue -- it is the pane switching into its reviewer
        // view (§1d: accept / revert / edit, batch filters). This route's
        // only job is to hand back a fresh count so the UI has something to
        // show the moment the view opens, without a second round trip.
        const pending = listSuggestions(r.context, { filter: { tier: "suggested" } }).total;
        return ok({ opened: true, pending });
      }),
  },
];

/** True when a project directory looks like it has a readable tree at all
 *  (spec 28's own `treeDir` convention) -- `server.ts` can use this to
 *  decide whether to build a `ReadabilityRoutesCtx` at all. Exported rather
 *  than inlined so a test can assert the same check the server uses. */
export function hasReadableTree(treeDir: string): boolean {
  return existsSync(treeDir);
}
