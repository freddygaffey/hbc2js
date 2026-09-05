// src/ui-server/workers-routes.ts — the HTTP surface of spec 23
// (docs/specs/23-ui-workers.md §6's "Server routes ... listed here as the
// contract"), spliced into `routes.ts`'s table so there is still exactly ONE
// `handle()` and one place a route can 404.
//
// Same shape as its neighbour: pure functions over a ctx, no `node:http`, so
// every route is unit-testable without a socket. Everything here reads or
// writes through the classes that already own the rules — `JobQueue`,
// `Presence`, `readWorkerEvents`, and (for anything authoritative)
// `McpTools`. This file adds no storage logic of its own.
//
// Two decisions worth reading before changing anything:
//
//  * **Reject writes nothing authoritative.** Spec 23 §4 is explicit —
//    "Rejection writes nothing; the suggestion comment stays as history". The
//    tag taxonomy (`src/project/schema.ts`'s closed `TAGS`) has no `rejected`
//    member and `worker_events.type` is closed by a CHECK constraint, so
//    there is no way to record a rejection as analysis without a schema
//    change — and there should not be one: a rejection is operational state.
//    It is therefore recorded on the JOB row (`jobs.result.rejected`), which
//    spec 23 §4.1 classifies as operational, never exported to a shard.
//  * **The runner is not driven from a route.** `POST /api/jobs` enqueues and
//    returns; the server's own loop (`server.ts`) claims. A route that ran a
//    job inline would make an HTTP request as long as a model call.
import type { DatabaseSync } from "node:sqlite";
import { Hbc2jsError } from "../errors.ts";
import type { McpTools } from "../mcp/tools.ts";
import type { Provenance } from "../project/schema.ts";
import { JOB_KINDS, type Job, type JobKind, type JobStatus, type JobQueue } from "../workers/queue.ts";
import type { Presence } from "../workers/presence.ts";
import { readWorkerEvents, type WorkerEvent } from "../workers/events.ts";
import { SUGGESTED_PREFIX, type JobResult, type WorkerRunner } from "../workers/runner.ts";
import type { UiRequest, UiResponse, UiServerCtx } from "./routes.ts";

/** Everything the worker routes need, built once by `server.ts` and hung off
 *  `UiServerCtx.workers`. Absent (undefined) when the server was started with
 *  `--workers off` or against a project with no DB — every route below then
 *  answers 503 rather than pretending to have a queue. */
export interface WorkersCtx {
  readonly db: DatabaseSync;
  readonly queue: JobQueue;
  readonly presence: Presence;
  readonly runner: WorkerRunner;
  /** The backend id in play (`heuristic`, `fake`, later `cli`/`http`) — the
   *  UI shows it so "why is this name so literal" has a visible answer. */
  readonly backendId: string;
  /** Concurrency cap the pool runs at (spec 23 §2.2: "the UI shows the cap"). */
  readonly concurrency: number;
}

type Handler = (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;

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

/** The one refusal this layer owns: workers are off (or unavailable), so the
 *  answer is "not here", not an empty list that reads like "no jobs". */
function noWorkers(): UiResponse {
  return { status: 503, json: { reason: "workers are disabled on this server (start without --workers off)" } };
}

function body(req: UiRequest): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/** The UI writes as a human named `ui`, same convention as
 *  `ui/src/actions/writes.ts`'s `UI_PROV`; a caller may override. */
const UI_PROV: Provenance = { source: "human", who: "ui" };

function provOf(b: Record<string, unknown>): Provenance {
  const p = b["prov"];
  if (typeof p === "object" && p !== null && typeof (p as { source?: unknown }).source === "string" && typeof (p as { who?: unknown }).who === "string") {
    return p as Provenance;
  }
  return UI_PROV;
}

// -- jobs --------------------------------------------------------------------

/** The `id.ts` target a job works on — the same derivation `WorkerRunner`
 *  makes (`fn:N` / `mod:N` / an explicit target / the project root). Mirrored
 *  rather than exported from the runner so this layer can classify a job row
 *  it did not run (e.g. one left in the DB by an earlier process). */
export function jobTarget(job: Job): string {
  if (typeof job.input["fn"] === "number") return `fn:${job.input["fn"] as number}`;
  if (typeof job.input["module"] === "number") return `mod:${job.input["module"] as number}`;
  return String(job.input["target"] ?? "project");
}

export interface JobRow extends Job {
  /** The target, precomputed so the jobs rail does not re-derive it. */
  readonly target: string;
  /** Milliseconds the job has been running / took, or null while queued —
   *  computed server-side so every client agrees on elapsed time. */
  readonly elapsedMs: number | null;
}

function toRow(job: Job, now: number): JobRow {
  const started = job.startedAt !== null ? Date.parse(job.startedAt) : Number.NaN;
  const finished = job.finishedAt !== null ? Date.parse(job.finishedAt) : Number.NaN;
  const elapsedMs = Number.isNaN(started) ? null : Math.max(0, (Number.isNaN(finished) ? now : finished) - started);
  return { ...job, target: jobTarget(job), elapsedMs };
}

export interface JobsResult {
  readonly rows: readonly JobRow[];
  readonly total: number;
  readonly backend: string;
  readonly concurrency: number;
}

// -- suggestions -------------------------------------------------------------

/** One promotable proposal. `kind:"name"` rows carry a `rid` that
 *  `McpTools.promote` resolves; `kind:"comment"` rows are the `[ai-suggested]`
 *  prose (spec 23 §4) and are informational — there is no truth slot for a
 *  comment to occupy, so they have nothing to promote INTO. */
export interface SuggestionRow {
  readonly rid: string;
  readonly target: string;
  readonly fn: number | null;
  readonly kind: "name" | "comment";
  readonly text: string;
  readonly who: string;
  readonly run: string | null;
  readonly ts: string;
  readonly rejected: boolean;
}

export interface SuggestionsResult {
  readonly rows: readonly SuggestionRow[];
  readonly total: number;
}

function fnOfTarget(target: string): number | null {
  const m = /^fn:(\d+)$/.exec(target);
  return m === null ? null : Number(m[1]);
}

/** Rids a human has rejected, read off the job rows (see this file's header:
 *  a rejection is operational state, never analysis). */
export function rejectedRids(queue: JobQueue): ReadonlySet<string> {
  const out = new Set<string>();
  for (const job of queue.list()) {
    const rejected = (job.result as { readonly rejected?: unknown } | null)?.rejected;
    if (Array.isArray(rejected)) for (const rid of rejected) if (typeof rid === "string") out.add(rid);
  }
  return out;
}

/** Records `rid` as rejected on whichever job wrote it. Returns false when no
 *  job claims that rid (a suggestion written by an external MCP client, say)
 *  — the route still answers 200: rejecting is allowed to write nothing, and
 *  saying "I could not find a job to note this on" is the honest result. */
export function rejectSuggestion(db: DatabaseSync, queue: JobQueue, rid: string): boolean {
  for (const job of queue.list()) {
    const result = job.result as (JobResult & { readonly rejected?: readonly string[] }) | null;
    if (result === null || !Array.isArray(result.writes)) continue;
    if (!result.writes.some((w) => w.rid === rid)) continue;
    const rejected = [...new Set([...(result.rejected ?? []), rid])];
    db.prepare("UPDATE jobs SET result = ? WHERE id = ?").run(JSON.stringify({ ...result, rejected }), job.id);
    return true;
  }
  return false;
}

/** Every suggestion on one target: the `tier:"suggested"` names (promotable
 *  by rid) plus the `[ai-suggested]` comments. */
function suggestionsForTarget(ctx: UiServerCtx, target: string, rejected: ReadonlySet<string>): readonly SuggestionRow[] {
  const fn = fnOfTarget(target);
  const rows: SuggestionRow[] = ctx.resources.project.listSuggestedNames(target).map((s) => ({
    rid: s.rid,
    target,
    fn,
    kind: "name" as const,
    text: s.name,
    who: s.who,
    run: s.run ?? null,
    ts: s.ts,
    rejected: rejected.has(s.rid),
  }));
  if (fn !== null) {
    for (const row of ctx.resources.annotationsForFn(fn, { all: true }).rows) {
      if (row.type !== "comment") continue;
      const rec = row.record;
      if (!rec.body.startsWith(SUGGESTED_PREFIX)) continue;
      rows.push({
        rid: rec.rid,
        target,
        fn,
        kind: "comment",
        text: rec.body.slice(SUGGESTED_PREFIX.length).trim(),
        who: rec.prov.who,
        run: rec.prov.run ?? null,
        ts: rec.ts,
        rejected: rejected.has(rec.rid),
      });
    }
  }
  return rows;
}

/** With no `?fn=`, "all suggestions" means every target a JOB has touched —
 *  bounded by the job table, which is small, instead of walking 43k functions
 *  looking for annotations. A suggestion that no job produced is by
 *  definition not this server's worker output. */
function allSuggestions(ctx: UiServerCtx, workers: WorkersCtx): readonly SuggestionRow[] {
  const rejected = rejectedRids(workers.queue);
  const targets = [...new Set(workers.queue.list().map(jobTarget))];
  return targets.flatMap((t) => suggestionsForTarget(ctx, t, rejected));
}

// -- the table ---------------------------------------------------------------

const WORKER_EVENTS_CAP = 500;

export const WORKER_ROUTES: readonly Route[] = [
  {
    method: "GET",
    re: /^\/api\/jobs$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const status = req.query["status"];
      if (status !== undefined && !["queued", "running", "done", "failed", "cancelled"].includes(status)) {
        return badRequest(`jobs: unknown ?status=${status}`);
      }
      const now = Date.now();
      const rows = w.queue.list(status !== undefined ? { status: status as JobStatus } : {}).map((j) => toRow(j, now));
      const result: JobsResult = { rows, total: rows.length, backend: w.backendId, concurrency: w.concurrency };
      return ok(result);
    },
  },
  {
    method: "POST",
    re: /^\/api\/jobs$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const b = body(req);
      const kind = b["kind"];
      if (typeof kind !== "string" || !(JOB_KINDS as readonly string[]).includes(kind)) {
        return badRequest(`jobs: kind must be one of ${JOB_KINDS.join(", ")}`);
      }
      const input = b["input"];
      if (typeof input !== "object" || input === null || Array.isArray(input)) return badRequest("jobs: input must be an object");
      const idem = b["idempotencyKey"];
      const createdBy = b["createdBy"];
      // `jobs.created_by` is `TEXT REFERENCES sessions(id)` (FK enforcement
      // on) — an unknown id would otherwise reach sqlite as a 500 "FOREIGN
      // KEY constraint failed". Validate here so a caller gets a clear 400
      // instead (found via the UI sending a literal "ui", never a real
      // session — docs/BUGS.md).
      if (typeof createdBy === "string" && createdBy !== "" && w.presence.session(createdBy) === undefined) {
        return badRequest(`jobs: createdBy "${createdBy}" is not a known session id (POST /api/sessions first)`);
      }
      return ok(
        w.queue.enqueue({
          kind: kind as JobKind,
          input: input as Record<string, unknown>,
          ...(typeof idem === "string" ? { idempotencyKey: idem } : {}),
          ...(typeof createdBy === "string" ? { createdBy } : {}),
        }),
      );
    },
  },
  {
    method: "POST",
    re: /^\/api\/jobs\/([^/]+)\/cancel$/,
    handler: ([raw], _req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const id = decodeURIComponent(raw!);
      const cancelled = w.queue.cancel(id);
      const job = w.queue.get(id);
      if (job === undefined) return { status: 404, json: { reason: `jobs/${id}: no such job` } };
      return ok({ cancelled, job: toRow(job, Date.now()) });
    },
  },
  // -- presence (spec 23 §3) -------------------------------------------------
  {
    method: "GET",
    re: /^\/api\/sessions$/,
    handler: (_p, _req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      // TTL is computed on read (§3) — expire first, so "live" is true.
      w.presence.expire();
      const rows = w.presence.liveSessions();
      return ok({ rows, total: rows.length });
    },
  },
  {
    method: "POST",
    re: /^\/api\/sessions$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const b = body(req);
      const kind = b["kind"];
      const who = b["who"];
      if (kind !== "human" && kind !== "worker" && kind !== "external") return badRequest("sessions: kind must be human|worker|external");
      if (typeof who !== "string" || who === "") return badRequest("sessions: who is required");
      const meta = b["meta"];
      return ok(w.presence.open({ kind, who, ...(typeof meta === "object" && meta !== null ? { meta: meta as Record<string, unknown> } : {}) }));
    },
  },
  {
    method: "POST",
    re: /^\/api\/sessions\/([^/]+)\/heartbeat$/,
    handler: ([raw], _req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const id = decodeURIComponent(raw!);
      const live = w.presence.heartbeat(id);
      return live ? ok({ id, live }) : { status: 404, json: { reason: `sessions/${id}: no open session` } };
    },
  },
  // -- the change feed (spec 23 §4.1), cursor semantics of /api/log/tail -----
  {
    method: "GET",
    re: /^\/api\/worker-events$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const raw = req.query["since"];
      const since = raw === undefined || raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(since)) return badRequest("worker-events: ?since= must be a number");
      return ok(tailWorkerEvents(w.db, since));
    },
  },
  // -- suggestions + promotion (spec 23 §4) ---------------------------------
  {
    method: "GET",
    re: /^\/api\/suggestions$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const raw = req.query["fn"];
      if (raw === undefined || raw === "") {
        const rows = allSuggestions(ctx, w);
        const result: SuggestionsResult = { rows, total: rows.length };
        return ok(result);
      }
      const fn = Number(raw);
      if (!Number.isInteger(fn)) return badRequest(`suggestions: ?fn=${raw} is not a function index`);
      const rows = suggestionsForTarget(ctx, `fn:${fn}`, rejectedRids(w.queue));
      const result: SuggestionsResult = { rows, total: rows.length };
      return ok(result);
    },
  },
  {
    method: "POST",
    re: /^\/api\/suggestions\/promote$/,
    handler: (_p, req, ctx) => {
      const b = body(req);
      const kind = b["kind"] ?? "name";
      if (kind !== "name") return badRequest("suggestions/promote: only kind:'name' is promotable (spec 23 §4)");
      const target = b["target"];
      if (typeof target !== "string" || target === "") return badRequest("suggestions/promote: target is required");
      const rid = b["rid"];
      const name = b["name"];
      if (typeof rid !== "string" && typeof name !== "string") return badRequest("suggestions/promote: one of rid|name is required");
      const input: Parameters<McpTools["promote"]>[0] = {
        kind: "name",
        target,
        ...(typeof rid === "string" ? { rid } : {}),
        ...(typeof name === "string" ? { name } : {}),
        prov: provOf(b),
      };
      return ok(ctx.tools.promote(input));
    },
  },
  {
    method: "POST",
    re: /^\/api\/suggestions\/reject$/,
    handler: (_p, req, ctx) => {
      const w = ctx.workers;
      if (w === undefined) return noWorkers();
      const b = body(req);
      const rid = b["rid"];
      if (typeof rid !== "string" || rid === "") return badRequest("suggestions/reject: rid is required");
      // §4: "Rejection writes nothing" — no revision, no annotation, no log
      // row. The note lands on the job, which is operational state (§4.1).
      const recorded = rejectSuggestion(w.db, w.queue, rid);
      return ok({ rid, rejected: true, recorded, wrote: false });
    },
  },
];

export interface WorkerEventsTail {
  readonly rows: readonly WorkerEvent[];
  readonly cursor: number;
}

/** `/api/worker-events?since=<seq>` — the same contract `/api/log/tail` has:
 *  `since` is the last `seq` already applied (0 the first time), rows come
 *  back oldest-first, and `cursor` is the highest `seq` returned (or `since`
 *  when nothing was new) to feed the next poll. */
export function tailWorkerEvents(db: DatabaseSync, since: number): WorkerEventsTail {
  const rows = readWorkerEvents(db, { since, limit: WORKER_EVENTS_CAP });
  return { rows, cursor: rows.length > 0 ? rows[rows.length - 1]!.seq : since };
}

/** Re-exported for `server.ts` and for tests: what an error from a worker
 *  route looks like once `handle()` has caught it. */
export { Hbc2jsError };
