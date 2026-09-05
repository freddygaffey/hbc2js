// ui/src/workers/wire.ts — the client half of spec 23's HTTP surface
// (src/ui-server/workers-routes.ts owns the server half; docs/UI.md lists
// both). Deliberately its OWN client rather than more entries on
// `ui/src/api.ts`'s `Api` interface: the worker routes are a self-contained
// feature that 503s when the server runs `--workers off`, and every consumer
// of them is under ui/src/workers/ + the pane.
//
// Mock mode (`VITE_API_MOCK=1`, the default with no server) answers from a
// tiny in-memory pool so the pane can be looked at without a backend; a WRITE
// in mock mode refuses loudly, same rule `ui/src/actions/writes.ts` follows.
import { API_BASE, USING_MOCK, authHeaders } from "../api.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobRow {
  readonly id: string;
  readonly kind: string;
  readonly input: Record<string, unknown>;
  readonly status: JobStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly progressDone: number;
  readonly progressTotal: number | null;
  readonly attempts: number;
  readonly error: string | null;
  readonly cost: { readonly tokensIn?: number; readonly tokensOut?: number; readonly usd?: number } | null;
  readonly target: string;
  readonly elapsedMs: number | null;
}

export interface JobsResult {
  readonly rows: readonly JobRow[];
  readonly total: number;
  readonly backend: string;
  readonly concurrency: number;
}

export interface SessionRow {
  readonly id: string;
  readonly kind: "human" | "worker" | "external";
  readonly who: string;
  readonly openedAt: string;
  readonly lastSeen: string;
}

export interface SessionsResult {
  readonly rows: readonly SessionRow[];
  readonly total: number;
}

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

export interface WorkerEvent {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly session: string | null;
  readonly job: string | null;
  readonly target: string | null;
  readonly detail: Record<string, unknown> | null;
}

export interface WorkerEventsTail {
  readonly rows: readonly WorkerEvent[];
  readonly cursor: number;
}

/** The one refusal this layer has to explain: the server was started with
 *  `--workers off` (or has no project DB), so there is no queue to talk to.
 *  Kept as a distinguishable class so the pane can say that instead of
 *  drawing an empty jobs rail, which would read as "nothing to do". */
export class WorkersUnavailable extends Error {}

export class WorkersApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WorkersApiError";
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(`/api${path}`, API_BASE), {
    ...init,
    headers: { accept: "application/json", ...authHeaders(), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? {} : JSON.parse(text);
  } catch {
    parsed = { reason: text };
  }
  if (res.status === 503) throw new WorkersUnavailable(String((parsed as { reason?: string }).reason ?? "workers are disabled"));
  if (!res.ok) throw new WorkersApiError(res.status, String((parsed as { reason?: string }).reason ?? res.statusText));
  return parsed as T;
}

const MOCK_JOBS: JobsResult = {
  rows: [
    {
      id: "mockjob1", kind: "suggest-name", input: { fn: 188 }, status: "done", createdAt: "2026-09-04T10:00:00.000Z",
      startedAt: "2026-09-04T10:00:00.000Z", finishedAt: "2026-09-04T10:00:01.200Z", progressDone: 1, progressTotal: 1,
      attempts: 1, error: null, cost: { tokensIn: 0, tokensOut: 0 }, target: "fn:188", elapsedMs: 1200,
    },
  ],
  total: 1,
  backend: "mock",
  concurrency: 2,
};

const MOCK_SESSIONS: SessionsResult = {
  rows: [
    { id: "s1", kind: "worker", who: "worker:heuristic", openedAt: "2026-09-04T10:00:00.000Z", lastSeen: "2026-09-04T10:00:10.000Z" },
    { id: "s2", kind: "human", who: "ui", openedAt: "2026-09-04T10:00:00.000Z", lastSeen: "2026-09-04T10:00:10.000Z" },
  ],
  total: 2,
};

function mockWrite(): never {
  throw new WorkersApiError(0, "the shell is in mock mode — start src/ui-server and run the dev server with VITE_API_MOCK=0 to queue work");
}

export const workersApi = {
  jobs: (status?: JobStatus): Promise<JobsResult> =>
    USING_MOCK ? Promise.resolve(MOCK_JOBS) : call(`/jobs${status !== undefined ? `?status=${status}` : ""}`),
  sessions: (): Promise<SessionsResult> => (USING_MOCK ? Promise.resolve(MOCK_SESSIONS) : call("/sessions")),
  suggestions: (fn?: number): Promise<SuggestionsResult> =>
    USING_MOCK ? Promise.resolve({ rows: [], total: 0 }) : call(`/suggestions${fn !== undefined ? `?fn=${fn}` : ""}`),
  workerEvents: (since: number): Promise<WorkerEventsTail> =>
    USING_MOCK ? Promise.resolve({ rows: [], cursor: since }) : call(`/worker-events?since=${since}`),
  // `createdBy`, when given, must be a REAL open session id — the jobs
  // table's `created_by TEXT REFERENCES sessions(id)` (src/projdb/schema.sql)
  // is enforced, and the UI never opens a `POST /api/sessions` presence
  // session for itself (only the worker pool does, in startWorkers). This
  // used to send the literal string "ui" here, which is not any session's
  // id, so EVERY job the UI ever queued 500'd with "FOREIGN KEY constraint
  // failed" the moment sqlite's foreign-key enforcement was on — found by
  // ui/e2e/ai-suggestions.spec.ts (2026-09-05), matching Fred's "none of
  // the AI features [are] working". Omitting it leaves `created_by` NULL
  // (allowed: the column has no NOT NULL), which is honest — the UI does
  // not yet have a real presence session to attribute this to.
  enqueue: (kind: string, input: Record<string, unknown>): Promise<{ readonly job: JobRow; readonly deduped: boolean }> =>
    USING_MOCK ? mockWrite() : call("/jobs", { method: "POST", body: JSON.stringify({ kind, input }) }),
  cancel: (id: string): Promise<{ readonly cancelled: boolean; readonly job: JobRow }> =>
    USING_MOCK ? mockWrite() : call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  promote: (target: string, rid: string): Promise<{ readonly rid: string; readonly line: string }> =>
    USING_MOCK ? mockWrite() : call("/suggestions/promote", { method: "POST", body: JSON.stringify({ kind: "name", target, rid }) }),
  reject: (rid: string): Promise<{ readonly rid: string; readonly recorded: boolean }> =>
    USING_MOCK ? mockWrite() : call("/suggestions/reject", { method: "POST", body: JSON.stringify({ rid }) }),
};
