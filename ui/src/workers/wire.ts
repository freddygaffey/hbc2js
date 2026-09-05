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

// -- this tab's own session (spec 23 §3 Presence) ---------------------------
//
// docs/BUGS.md "UI enqueues jobs without a session id": the UI polled
// GET /api/sessions for presence chips but never opened one of its own, so
// every job it queued had no `createdBy` and the jobs rail could not show
// who queued it. `initUiSession()` registers ONE `kind: "human"` session on
// load and heartbeats it for as long as the tab is open (spec: TTL 30 s,
// "the UI beats every 10 s"); `enqueue()` below reads the id back through
// `uiSessionId()` and sends it as `createdBy`, or omits the field entirely
// before the session opens (still a real, supported shape server-side).
//
// Module-level singleton state, like ui/src/state/url.ts's `initUrlSync`:
// `App` never unmounts in production, but a test harness does, so the
// returned cleanup stops the heartbeat and forgets the id rather than
// leaving a timer running (or a later test heartbeating a session THIS
// process's teardown closed).
const UI_HEARTBEAT_MS = 10_000;

let uiSessionIdValue: string | null = null;
let uiSessionOpening: Promise<void> | null = null;
let uiHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function uiSessionId(): string | null {
  return uiSessionIdValue;
}

/** `{ createdBy: id }` once the session is open, `{}` before it is (or in
 *  mock mode, which never opens one) — never a hardcoded session-id literal
 *  (the previous shortcut, a bare "ui" string no session owned, 500ed every
 *  enqueue with a foreign-key failure). */
function createdByField(): { readonly createdBy: string } | Record<string, never> {
  return uiSessionIdValue !== null ? { createdBy: uiSessionIdValue } : {};
}

export function initUiSession(): () => void {
  if (!USING_MOCK && uiSessionIdValue === null && uiSessionOpening === null) {
    uiSessionOpening = call<SessionRow>("/sessions", { method: "POST", body: JSON.stringify({ kind: "human", who: "ui" }) })
      .then((row) => {
        uiSessionIdValue = row.id;
        if (uiHeartbeatTimer === null) {
          uiHeartbeatTimer = setInterval(() => {
            const id = uiSessionIdValue;
            if (id !== null) void call(`/sessions/${encodeURIComponent(id)}/heartbeat`, { method: "POST", body: "{}" }).catch(() => {});
          }, UI_HEARTBEAT_MS);
        }
      })
      .catch(() => {
        // Presence is best-effort: a failed registration just means jobs
        // keep enqueuing with no createdBy, same as before this landed.
      })
      .finally(() => {
        uiSessionOpening = null;
      });
  }
  return () => {
    if (uiHeartbeatTimer !== null) {
      clearInterval(uiHeartbeatTimer);
      uiHeartbeatTimer = null;
    }
    uiSessionIdValue = null;
  };
}

export const workersApi = {
  jobs: (status?: JobStatus): Promise<JobsResult> =>
    USING_MOCK ? Promise.resolve(MOCK_JOBS) : call(`/jobs${status !== undefined ? `?status=${status}` : ""}`),
  sessions: (): Promise<SessionsResult> => (USING_MOCK ? Promise.resolve(MOCK_SESSIONS) : call("/sessions")),
  suggestions: (fn?: number): Promise<SuggestionsResult> =>
    USING_MOCK ? Promise.resolve({ rows: [], total: 0 }) : call(`/suggestions${fn !== undefined ? `?fn=${fn}` : ""}`),
  workerEvents: (since: number): Promise<WorkerEventsTail> =>
    USING_MOCK ? Promise.resolve({ rows: [], cursor: since }) : call(`/worker-events?since=${since}`),
  // `createdBy` is a `jobs.created_by TEXT REFERENCES sessions(id)` FK.
  // `createdByField()` (above) sends the id THIS tab registered via
  // `initUiSession()`, or omits the field before that registration settles
  // — never a literal like `"ui"` that no session owns (that 500ed every
  // enqueue: FOREIGN KEY constraint failed). Omitting it is a real,
  // supported shape server-side (`created_by` is nullable).
  enqueue: (kind: string, input: Record<string, unknown>): Promise<{ readonly job: JobRow; readonly deduped: boolean }> =>
    USING_MOCK ? mockWrite() : call("/jobs", { method: "POST", body: JSON.stringify({ kind, input, ...createdByField() }) }),
  cancel: (id: string): Promise<{ readonly cancelled: boolean; readonly job: JobRow }> =>
    USING_MOCK ? mockWrite() : call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }),
  promote: (target: string, rid: string): Promise<{ readonly rid: string; readonly line: string }> =>
    USING_MOCK ? mockWrite() : call("/suggestions/promote", { method: "POST", body: JSON.stringify({ kind: "name", target, rid }) }),
  reject: (rid: string): Promise<{ readonly rid: string; readonly recorded: boolean }> =>
    USING_MOCK ? mockWrite() : call("/suggestions/reject", { method: "POST", body: JSON.stringify({ rid }) }),
};
