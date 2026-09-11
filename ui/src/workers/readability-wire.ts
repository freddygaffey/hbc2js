// ui/src/workers/readability-wire.ts — the client half of spec 28 landing
// 4c's HTTP surface (src/ui-server/readability-routes.ts owns the server
// half; docs/READABILITY.md and docs/UI.md list both). A DIFFERENT pipeline
// from ./wire.ts's `/api/jobs`+`/api/suggestions` (spec 23's job queue and
// `[ai-suggested]` comment convention) — this one is spec 28's name-overlay
// + transaction log (`src/readability/surfaces.ts`'s `SuggestionItem`
// union), so it gets its own client rather than more branches on the
// existing one, same reasoning `./wire.ts`'s own header gives for staying
// off `ui/src/api.ts`.
//
// Mock mode (`VITE_API_MOCK=1`) answers from a tiny fixed pool, same
// convention as `./wire.ts`; a write in mock mode refuses loudly.
import { API_BASE, USING_MOCK, authHeaders } from "../api.ts";
import { workersApi } from "./wire.ts";

export type SuggestionTier = "suggested" | "confirmed";
export type SuggestionConfidence = "low" | "med" | "high";

/** A name proposal from the overlay (P-59), addressed by the overlay
 *  record's own `rid` — mirrors `NameSuggestionItem` in
 *  `src/readability/surfaces.ts`. */
export interface NameSuggestionRow {
  readonly kind: "name";
  readonly suggestionId: string;
  readonly bindingId: { readonly fn: number; readonly reg?: number };
  readonly name: string;
  readonly confidence: SuggestionConfidence;
  readonly evidence: string;
  readonly tier: SuggestionTier;
  readonly ts: string;
}

/** `EmittedFile` (src/readability/types.ts): a path plus the bytecode
 *  origins it traces to. Rendered content for the before/after panel comes
 *  separately, on `TxSuggestionRow.priorContent`/`newContent` below (landing
 *  4d) — this shape stays a structural copy of the wire type, unchanged. */
export interface EmittedFileRow {
  readonly path: string;
  readonly origins: readonly { readonly module: number }[];
}

/** A rewrite/file-op transaction, mirrors `ReadabilityTransaction`
 *  (src/readability/types.ts) closely enough for the pane's own columns —
 *  a structural copy, not an import (ui/ is a separate package, same rule
 *  ui/src/contracts.ts's header states for the McpResources shapes). */
export interface ReadabilityTxRow {
  readonly id: string;
  readonly op: "make" | "rename" | "move" | "combine" | "split" | "rewrite";
  readonly tier: SuggestionTier;
  readonly who: string;
  readonly ts: string;
  readonly inputs: readonly { readonly module: number }[];
  readonly outputs: readonly EmittedFileRow[];
  readonly evidence: string;
  readonly prior: { readonly files: readonly { readonly path: string; readonly sha256: string }[] };
  readonly equiv: { readonly scope: string; readonly verdict: "PASS" | "FAIL" | "DIVERGENT" | "INCONCLUSIVE"; readonly oracle: string };
}

export interface TxSuggestionRow {
  readonly kind: "tx";
  readonly tx: ReadabilityTxRow;
  /** Spec 28 landing 4d ("diff content", docs/BUGS.md resolved): rendered
   *  text for the before/after panel, keyed by path — `priorContent` reads
   *  the DB-held blob the transaction log already keeps for `revert`;
   *  `newContent` reads whatever `treeDir` currently holds at each output
   *  path. Either map may omit a path (file gone / blob missing) — the
   *  panel falls back to the path + hash it already showed for that one
   *  entry, never a crash. */
  readonly priorContent?: Readonly<Record<string, string>>;
  readonly newContent?: Readonly<Record<string, string>>;
}

export type ReadabilitySuggestionRow = NameSuggestionRow | TxSuggestionRow;

export interface ReadabilitySuggestionsResult {
  readonly suggestions: readonly ReadabilitySuggestionRow[];
  readonly total: number;
  readonly backend: string;
}

export interface ReadabilityFilter {
  readonly tier?: SuggestionTier;
  readonly confidence?: SuggestionConfidence;
  readonly module?: number;
  readonly securityRelevant?: boolean;
}

/** Same "not configured" convention as `./wire.ts`'s `WorkersUnavailable`:
 *  the server has no readable tree / backend for this project. */
export class ReadabilityUnavailable extends Error {}

export class ReadabilityApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ReadabilityApiError";
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(`/api/readability${path}`, API_BASE), {
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
  if (res.status === 503) throw new ReadabilityUnavailable(String((parsed as { reason?: string }).reason ?? "readability is disabled"));
  if (!res.ok) throw new ReadabilityApiError(res.status, String((parsed as { reason?: string }).reason ?? res.statusText));
  return parsed as T;
}

function query(filter: ReadabilityFilter, limit?: number): string {
  const params = new URLSearchParams();
  if (filter.tier !== undefined) params.set("tier", filter.tier);
  if (filter.confidence !== undefined) params.set("confidence", filter.confidence);
  if (filter.module !== undefined) params.set("module", String(filter.module));
  if (filter.securityRelevant !== undefined) params.set("securityRelevant", String(filter.securityRelevant));
  if (limit !== undefined) params.set("limit", String(limit));
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

function mockWrite(): never {
  throw new ReadabilityApiError(0, "the shell is in mock mode — start src/ui-server and run the dev server with VITE_API_MOCK=0 to act on suggestions");
}

const MOCK_SUGGESTIONS: ReadabilitySuggestionsResult = { suggestions: [], total: 0, backend: "mock" };

// -- spec 28 landing 4d (PUSHBACK P-61 resolved): `suggest-names`/
// `rewrite-function`/`combine-files` now ENQUEUE (`POST /actions/*` answers
// `202 {jobId}`) instead of running to completion inline — this module polls
// the SAME `/api/jobs` list `ui/src/workers/wire.ts`'s jobs rail already
// polls until the job is terminal, then resolves/rejects with exactly the
// shape the surface call used to return directly. Callers of `readabilityApi`
// (`readability-hooks.ts`, and its mocks in tests) see NO shape change —
// this is the one place the enqueue-and-poll happens.
const JOB_POLL_MS = 500;
// Generous: a cold `suggest_names`/`rewrite_function` re-parses and
// re-analyses the WHOLE bytecode file with no cache (docs/BUGS.md), which
// measured over a minute on a real ~450-module bundle — this is a network
// polling budget, not a UI freeze, so it costs nothing while it waits.
const JOB_POLL_TIMEOUT_MS = 180_000;

async function awaitReadabilityJob<T>(jobId: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const { rows } = await workersApi.jobs();
    const job = rows.find((j) => j.id === jobId);
    if (job !== undefined) {
      if (job.status === "done") return job.result as T;
      if (job.status === "failed") throw new ReadabilityApiError(500, job.error ?? `job ${jobId} failed`);
      if (job.status === "cancelled") throw new ReadabilityApiError(499, `job ${jobId} was cancelled`);
    }
    if (Date.now() - start > JOB_POLL_TIMEOUT_MS) throw new ReadabilityApiError(504, `job ${jobId} did not finish in time`);
    await new Promise((resolvePoll) => setTimeout(resolvePoll, JOB_POLL_MS));
  }
}

export const readabilityApi = {
  suggestions: (filter: ReadabilityFilter = {}, limit?: number): Promise<ReadabilitySuggestionsResult> =>
    USING_MOCK ? Promise.resolve(MOCK_SUGGESTIONS) : call(`/suggestions${query(filter, limit)}`),
  promote: (id: { readonly txId?: string; readonly suggestionId?: string }, who: string): Promise<{ readonly txId: string; readonly tier: string }> =>
    USING_MOCK ? mockWrite() : call("/promote", { method: "POST", body: JSON.stringify({ ...id, who }) }),
  revert: (id: { readonly txId?: string; readonly suggestionId?: string }): Promise<{ readonly txId: string; readonly revertedTxId: string }> =>
    USING_MOCK ? mockWrite() : call("/revert", { method: "POST", body: JSON.stringify(id) }),
  suggestNames: async (target: { readonly module: number } | { readonly fn: number }): Promise<{ readonly suggestions: readonly unknown[] }> => {
    if (USING_MOCK) mockWrite();
    const { jobId } = await call<{ jobId: string }>("/actions/suggest-names", { method: "POST", body: JSON.stringify(target) });
    return awaitReadabilityJob(jobId);
  },
  rewriteFunction: async (fn: number): Promise<{ readonly accepted: boolean }> => {
    if (USING_MOCK) mockWrite();
    const { jobId } = await call<{ jobId: string }>("/actions/rewrite-function", { method: "POST", body: JSON.stringify({ fn }) });
    return awaitReadabilityJob(jobId);
  },
  combineFiles: async (inputs: readonly string[], outputs: readonly string[], evidence: string): Promise<{ readonly accepted: boolean }> => {
    if (USING_MOCK) mockWrite();
    const { jobId } = await call<{ jobId: string }>("/actions/combine-files", { method: "POST", body: JSON.stringify({ inputs, outputs, evidence }) });
    return awaitReadabilityJob(jobId);
  },
  review: (): Promise<{ readonly opened: boolean; readonly pending: number }> =>
    USING_MOCK ? Promise.resolve({ opened: true, pending: 0 }) : call("/actions/review", { method: "POST", body: "{}" }),
};
