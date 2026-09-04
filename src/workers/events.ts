// src/workers/events.ts — the worker/session change feed
// (docs/specs/23-ui-workers.md §4.1). An append-only table of lifecycle
// events, DELIBERATELY separate from the spec-18 `log` table:
//
//   * spec 18 §4's boundary rule makes `log` the durable, hash-chained record
//     of AUTHORITATIVE writes; job churn is operational state, and a job's
//     real output is the annotation it wrote through `McpTools` (which does
//     land in `log`, in a shard, and in the chain, with `actor_source='llm'`);
//   * `src/projdb/export.ts`'s `exportLog` keys every exported entry by
//     `log.rid` (it selects `rid` and emits it AS `seq`), so rows with no
//     revision would corrupt the exported chain's sequence. See PUSHBACK P-15.
//
// The feed is what the UI's jobs rail and any `log://tail`-style subscriber
// reads (spec 23 §5); it is rebuildable/disposable like the rest of
// `cache.db` (spec 18 §2) and is never exported to `analysis/`.
import type { DatabaseSync } from "node:sqlite";

/** The exact event vocabulary (spec 23 §4.1); mirrored by the CHECK
 *  constraint on `worker_events.type` in `schema.sql`'s MIGRATION 2 block. */
export const WORKER_EVENT_TYPES = [
  "session.open",
  "session.close",
  "job.queued",
  "job.started",
  "job.progress",
  "job.done",
  "job.failed",
  "job.cancelled",
  "claim.acquire",
  "claim.release",
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export interface WorkerEvent {
  readonly seq: number;
  readonly ts: string;
  readonly type: WorkerEventType;
  readonly session: string | null;
  readonly job: string | null;
  readonly target: string | null;
  readonly detail: Record<string, unknown> | null;
}

export interface WorkerEventInput {
  readonly type: WorkerEventType;
  readonly ts: string;
  readonly session?: string | null;
  readonly job?: string | null;
  readonly target?: string | null;
  readonly detail?: Record<string, unknown> | null;
}

/** Appends one event and returns its `seq`. The only writer of
 *  `worker_events` — the table's append-only triggers make an UPDATE/DELETE
 *  from anywhere else an error, exactly as for `log`/`revisions`. */
export function appendWorkerEvent(db: DatabaseSync, e: WorkerEventInput): number {
  db.prepare("INSERT INTO worker_events (ts, type, session, job, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    e.ts,
    e.type,
    e.session ?? null,
    e.job ?? null,
    e.target ?? null,
    e.detail === undefined || e.detail === null ? null : JSON.stringify(e.detail),
  );
  return Number((db.prepare("SELECT MAX(seq) AS seq FROM worker_events").get() as { seq: number }).seq);
}

interface EventRow {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly session: string | null;
  readonly job: string | null;
  readonly target: string | null;
  readonly detail: string | null;
}

function toEvent(r: EventRow): WorkerEvent {
  return {
    seq: Number(r.seq),
    ts: r.ts,
    type: r.type as WorkerEventType,
    session: r.session,
    job: r.job,
    target: r.target,
    detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
  };
}

/** The tail read the UI polls: every event after `since` (exclusive), oldest
 *  first, capped. `since: 0` is "from the beginning". */
export function readWorkerEvents(db: DatabaseSync, opts: { readonly since?: number; readonly limit?: number } = {}): readonly WorkerEvent[] {
  const since = opts.since ?? 0;
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare("SELECT seq, ts, type, session, job, target, detail FROM worker_events WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(since, limit) as unknown as EventRow[];
  return rows.map(toEvent);
}
