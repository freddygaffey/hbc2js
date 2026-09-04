// src/workers/queue.ts — the job queue over the `jobs` table
// (docs/specs/23-ui-workers.md §1, §2.2–§2.4). Pure storage + state machine:
// it never calls a model, never writes an annotation, and knows nothing about
// backends — the runner (`runner.ts`) owns that. Every transition appends its
// `worker_events` row (§4.1) so the UI's jobs rail is a pure read of the feed.
//
// State machine (the only legal transitions):
//   queued  -> running   (claimNext)
//   queued  -> cancelled (cancel)
//   running -> done      (finish)
//   running -> failed    (fail, terminal)   | -> queued (fail, transient, attempts < MAX)
//   running -> cancelled (cancel; the runner re-reads status before writing)
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../projdb/export.ts";
import { appendWorkerEvent } from "./events.ts";

/** §1's job kinds. */
export const JOB_KINDS = [
  "explain-fn",
  "suggest-name",
  "name-module",
  "summarise-leads",
  "doc-screen",
  "rerun-findings",
  "poc-finding",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** §1's `cost` block: the first two fields are LIMITS the runner enforces,
 *  the rest is what the run actually spent. */
export interface JobCost {
  readonly maxTokens?: number;
  readonly maxSeconds?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly usd?: number;
}

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly input: Record<string, unknown>;
  readonly status: JobStatus;
  readonly idempotencyKey: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly progressDone: number;
  readonly progressTotal: number | null;
  readonly attempts: number;
  readonly result: unknown;
  readonly error: string | null;
  readonly cost: JobCost | null;
}

export interface EnqueueInput {
  readonly kind: JobKind;
  readonly input: Record<string, unknown>;
  /** Defaults to `sha256(kind + canonical(input))` — §1's idempotency rule: a
   *  caller that wants a genuine re-run passes its own key. */
  readonly idempotencyKey?: string;
  readonly createdBy?: string | null;
  readonly cost?: JobCost;
}

export interface EnqueueResult {
  readonly job: Job;
  /** True when the key already existed: NO new row and NO `job.queued` event. */
  readonly deduped: boolean;
}

/** §2.4: at most three attempts, and only for transient failures. */
export const MAX_ATTEMPTS = 3;

export type Clock = () => number;

interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly input: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly created_by: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly progress_done: number;
  readonly progress_total: number | null;
  readonly attempts: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly cost: string | null;
}

const COLS =
  "id, kind, input, status, idempotency_key, created_by, created_at, started_at, finished_at, progress_done, progress_total, attempts, result, error, cost";

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind as JobKind,
    input: JSON.parse(r.input) as Record<string, unknown>,
    status: r.status as JobStatus,
    idempotencyKey: r.idempotency_key,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    progressDone: Number(r.progress_done),
    progressTotal: r.progress_total === null ? null : Number(r.progress_total),
    attempts: Number(r.attempts),
    result: r.result === null ? null : JSON.parse(r.result),
    error: r.error,
    cost: r.cost === null ? null : (JSON.parse(r.cost) as JobCost),
  };
}

/** `sha256(kind + canonical(input))` — the default idempotency key (§1). */
export function defaultIdempotencyKey(kind: JobKind, input: Record<string, unknown>): string {
  return sha256Hex(`${kind}\n${canonicalJson(input)}`);
}

export class JobQueue {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(db: DatabaseSync, opts: { readonly now?: Clock } = {}) {
    this.db = db;
    this.clock = opts.now ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Enqueues a job, or returns the existing one for the same idempotency key
   *  (§1). Dedup is UNCONDITIONAL on the key — including for a finished job —
   *  so "explain fn 188" twice is one job and one answer; a caller who wants
   *  it recomputed says so by passing a distinct key. */
  enqueue(input: EnqueueInput): EnqueueResult {
    const key = input.idempotencyKey ?? defaultIdempotencyKey(input.kind, input.input);
    const existing = this.db.prepare(`SELECT ${COLS} FROM jobs WHERE idempotency_key = ?`).get(key) as unknown as JobRow | undefined;
    if (existing !== undefined) return { job: toJob(existing), deduped: true };

    const ts = this.nowIso();
    const id = sha256Hex(`${input.kind}\n${canonicalJson(input.input)}\n${key}`).slice(0, 32);
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, input, status, idempotency_key, created_by, created_at, progress_done, progress_total, attempts, cost)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, 0, ?)`,
      )
      .run(
        id,
        input.kind,
        canonicalJson(input.input),
        key,
        input.createdBy ?? null,
        ts,
        null,
        input.cost === undefined ? null : canonicalJson(input.cost),
      );
    appendWorkerEvent(this.db, {
      type: "job.queued",
      ts,
      job: id,
      session: input.createdBy ?? null,
      target: (input.input["target"] as string | undefined) ?? null,
      detail: { kind: input.kind },
    });
    return { job: this.get(id)!, deduped: false };
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare(`SELECT ${COLS} FROM jobs WHERE id = ?`).get(id) as unknown as JobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  list(opts: { readonly status?: JobStatus } = {}): readonly Job[] {
    const rows =
      opts.status === undefined
        ? (this.db.prepare(`SELECT ${COLS} FROM jobs ORDER BY created_at, id`).all() as unknown as JobRow[])
        : (this.db.prepare(`SELECT ${COLS} FROM jobs WHERE status = ? ORDER BY created_at, id`).all(opts.status) as unknown as JobRow[]);
    return rows.map(toJob);
  }

  /** Atomically takes the oldest queued job (§2.2): one conditional UPDATE, so
   *  two runner loops — in this process or another — never take the same job. */
  claimNext(): Job | undefined {
    for (;;) {
      const cand = this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (cand === undefined) return undefined;
      const ts = this.nowIso();
      const res = this.db
        .prepare("UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'")
        .run(ts, cand.id);
      // Lost the race to another runner (0 rows changed): try the next one.
      if (Number(res.changes) === 0) continue;
      const job = this.get(cand.id)!;
      appendWorkerEvent(this.db, { type: "job.started", ts, job: job.id, session: job.createdBy, detail: { attempt: job.attempts } });
      return job;
    }
  }

  /** Progress ping for the jobs rail. Ignored for a job that is no longer
   *  running (a cancelled job's late progress is not an error). */
  progress(id: string, done: number, total?: number): void {
    const job = this.get(id);
    if (job === undefined || job.status !== "running") return;
    this.db.prepare("UPDATE jobs SET progress_done = ?, progress_total = COALESCE(?, progress_total) WHERE id = ?").run(done, total ?? null, id);
    appendWorkerEvent(this.db, { type: "job.progress", ts: this.nowIso(), job: id, session: job.createdBy, detail: { done, total: total ?? job.progressTotal } });
  }

  /** Terminal success. Refuses to overwrite a job that is not running — a
   *  cancelled job never becomes `done` (§2.3's write guarantee). */
  finish(id: string, out: { readonly result: unknown; readonly cost?: JobCost }): Job | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "running") return job;
    const ts = this.nowIso();
    this.db
      .prepare("UPDATE jobs SET status = 'done', finished_at = ?, result = ?, cost = COALESCE(?, cost) WHERE id = ? AND status = 'running'")
      .run(ts, canonicalJson(out.result ?? null), out.cost === undefined ? null : canonicalJson({ ...(job.cost ?? {}), ...out.cost }), id);
    appendWorkerEvent(this.db, { type: "job.done", ts, job: id, session: job.createdBy, detail: { kind: job.kind } });
    return this.get(id);
  }

  /** Failure. `transient: true` requeues while attempts remain (§2.4);
   *  everything else is terminal — a schema-invalid answer or a bad input is
   *  never retried, it would fail identically. */
  fail(id: string, error: string, opts: { readonly transient?: boolean } = {}): Job | undefined {
    const job = this.get(id);
    if (job === undefined || job.status !== "running") return job;
    const ts = this.nowIso();
    const requeue = opts.transient === true && job.attempts < MAX_ATTEMPTS;
    if (requeue) {
      this.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL, error = ? WHERE id = ? AND status = 'running'").run(error, id);
    } else {
      this.db.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'").run(ts, error, id);
    }
    appendWorkerEvent(this.db, { type: "job.failed", ts, job: id, session: job.createdBy, detail: { error, requeued: requeue, attempts: job.attempts } });
    return this.get(id);
  }

  /** §2.3. A queued job never starts; a running job is marked cancelled and
   *  the runner — which re-reads the status before writing — discards its
   *  output. Returns false when the job is already terminal. */
  cancel(id: string): boolean {
    const job = this.get(id);
    if (job === undefined) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    const ts = this.nowIso();
    this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(ts, id);
    appendWorkerEvent(this.db, { type: "job.cancelled", ts, job: id, session: job.createdBy, detail: { from: job.status } });
    return true;
  }
}
