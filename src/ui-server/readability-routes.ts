// src/ui-server/readability-routes.ts -- spec 28 landing 4c: the HTTP surface
// over `src/readability/surfaces.ts` (the same functions the MCP tools call,
// `src/mcp/tools.ts`), spliced into `routes.ts`'s table exactly like
// `workers-routes.ts`'s `WORKER_ROUTES` is. Pure functions over a ctx, no
// `node:http`, so every route is unit-testable without a socket.
//
// This is a DIFFERENT pipeline from `workers-routes.ts`'s `/api/jobs` +
// `/api/suggestions`: those run through `JobQueue`/`WorkerRunner` and the
// older `[ai-suggested]` annotation-comment convention (spec 23). The
// readability surfaces (`suggestNames`/`rewriteFunction`/`fileOp`) write
// through the name-overlay and the `readability_tx` transaction log instead
// (spec 28 landing 3-4, P-59) and never touch `JobQueue` -- `JOB_KINDS` has
// no `rewrite-function`/`combine-files` member and `WorkerRunner` has no
// readability-aware branch, and extending either is out of this landing's
// file scope (see the PUSHBACK row this file's header cites). The four UI
// actions below therefore call the surface function directly and answer
// once it settles, rather than enqueuing a `JobRow` a client would poll --
// PUSHBACK P-60 records this as a design decision the spec text did not
// settle ("job enqueues through the spec-23 queue" assumes a JobKind that
// does not exist yet).
import { existsSync } from "node:fs";
import {
  fileOp,
  listSuggestions,
  promoteChange,
  revertChange,
  rewriteFunction,
  suggestNames,
  ReadabilitySurfaceError,
  type ListSuggestionsFilter,
  type ReadabilityContext,
} from "../readability/surfaces.ts";
import { TransactionRefused } from "../readability/transactions.ts";
import { FileOpError } from "../readability/file-ops.ts";
import type { UiRequest, UiResponse } from "./routes.ts";

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
    // `securityRelevant` is accepted here for forward compatibility with the
    // spec-28 §9.7 `list_suggestions` filter table, but `listSuggestions`
    // itself does not yet apply it (no ground-truth field on a `NameRecord`
    // or a `ReadabilityTransaction` to filter by) -- docs/BUGS.md row filed
    // alongside this file, not silently dropped.
    ...(securityRelevant !== undefined ? { securityRelevant } : {}),
  };
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
      return ok({ ...result, backend: r.backendId });
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
  // -- the four spec 28 section 9.7 UI actions, run to completion rather
  // than queued (this file's header) -----------------------------------
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/suggest-names$/,
    handler: (_p, req, ctx) =>
      guarded(async () => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
        const b = body(req);
        const module = b["module"];
        const fn = b["fn"];
        if (typeof module !== "number" && typeof fn !== "number") {
          return badRequest("readability/actions/suggest-names: one of {module}|{fn} is required");
        }
        const target = typeof fn === "number" ? { fn } : { module: module as number };
        return ok(await suggestNames(r.context, { target }));
      }),
  },
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/rewrite-function$/,
    handler: (_p, req, ctx) =>
      guarded(async () => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
        const b = body(req);
        const fn = b["fn"];
        if (typeof fn !== "number") return badRequest("readability/actions/rewrite-function: fn is required");
        return ok(await rewriteFunction(r.context, { fn }));
      }),
  },
  {
    method: "POST",
    re: /^\/api\/readability\/actions\/combine-files$/,
    handler: (_p, req, ctx) =>
      guarded(() => {
        const r = ctx.readability;
        if (r === undefined) return noReadability();
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
        const result = fileOp(r.context, { op: "combine", from: inputs as readonly string[], to: outputs[0], evidence });
        return ok(result);
      }),
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
