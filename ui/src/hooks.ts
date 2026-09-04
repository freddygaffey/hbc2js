// ui/src/hooks.ts — TanStack Query hooks over ./api.ts. One hook per
// resource; components never call fetch directly. Query keys are
// `[resource, ...args]` so a write (spec 22 landing 5) can invalidate
// precisely, and the log poll (landing 6) has its own 1 s interval.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE, USING_MOCK, api, ApiError } from "./api.ts";
import type { FunctionListPage, FunctionListRow, ModuleListPage } from "./listing/wire.ts";
import type {
  Bounded, CallsFrom, FnContext, FnSummary, FunctionMatch, LeadsResult, LogEntry, LogTail,
  ModuleInfo, ModuleSource, PackageIdResult, ResolvedFinding, SearchPage, SourceText, WhoCalls,
} from "./contracts.ts";

export const LOG_POLL_MS = 1000;

/** A 4xx is the server telling us this resource does not exist for this
 *  function (fn 0 and fn 1 have no recorded source range, so `/source` and
 *  `/context` 400). Retrying it three times is noise; retry only 5xx. */
const retryServerErrorsOnly = (count: number, error: Error): boolean =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2;

/** Query options every per-function resource shares: skip the request when
 *  nothing is selected (`fn < 0`), and do not hammer a 4xx. */
const perFn = (fn: number): { enabled: boolean; retry: typeof retryServerErrorsOnly } => ({
  enabled: Number.isInteger(fn) && fn >= 0,
  retry: retryServerErrorsOnly,
});

/** True when `error` is the server saying "this function has no such
 *  resource" — an empty listing, not a failure to show the user. */
export const isMissingResource = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

export const useFn = (fn: number): UseQueryResult<FnSummary> =>
  useQuery({ queryKey: ["fn", fn], queryFn: () => api.fn(fn), ...perFn(fn) });

export const useSource = (fn: number): UseQueryResult<SourceText> =>
  useQuery({ queryKey: ["source", fn], queryFn: () => api.source(fn), ...perFn(fn) });

export const useDisasm = (fn: number): UseQueryResult<SourceText> =>
  useQuery({ queryKey: ["disasm", fn], queryFn: () => api.disasm(fn), ...perFn(fn) });

export const useContextResource = (fn: number): UseQueryResult<FnContext> =>
  useQuery({ queryKey: ["context", fn], queryFn: () => api.context(fn), ...perFn(fn) });

export const useWhoCalls = (fn: number): UseQueryResult<WhoCalls> =>
  useQuery({ queryKey: ["who-calls", fn], queryFn: () => api.whoCalls(fn), ...perFn(fn) });

export const useCallsFrom = (fn: number): UseQueryResult<CallsFrom> =>
  useQuery({ queryKey: ["calls-from", fn], queryFn: () => api.callsFrom(fn), ...perFn(fn) });

export const useModule = (id: number): UseQueryResult<ModuleInfo> =>
  useQuery({ queryKey: ["module", id], queryFn: () => api.module(id), ...perFn(id) });

export const usePackageId = (mod: number): UseQueryResult<PackageIdResult> =>
  useQuery({ queryKey: ["package-id", mod], queryFn: () => api.packageId(mod), ...perFn(mod) });

export const useFindings = (): UseQueryResult<Bounded<ResolvedFinding>> =>
  useQuery({ queryKey: ["findings"], queryFn: () => api.findings() });

export const useLeads = (): UseQueryResult<LeadsResult> =>
  useQuery({ queryKey: ["leads"], queryFn: () => api.leads() });

/** Rows kept in memory by {@link useLog} — the bottom pane never needs the
 *  full session history, and an unbounded array under a live feed is a
 *  slow leak waiting to happen. */
export const LOG_FEED_MAX_ROWS = 500;

/** Live tail of the append-only log (spec 22 §1/§3.5, wave-2 activity
 *  landing). `LogTail`'s own cursor semantics ("oldest-first, `cursor` is
 *  the highest `seq` returned") are exactly a `useReducer`-shaped stream:
 *  each delivery is *appended*, never replaces, the rows already held. */
export interface LogFeedState {
  /** Oldest-first, capped at {@link LOG_FEED_MAX_ROWS} (oldest dropped). */
  readonly rows: readonly LogEntry[];
  readonly cursor: number;
  /** `"sse"` once `GET /api/events` has delivered at least one frame,
   *  `"poll"` while the 1 s `/api/log/tail` fallback is the active source
   *  (also the only path under the mock adapter, which has no server),
   *  `"connecting"` before either has spoken. */
  readonly connected: "sse" | "poll" | "connecting";
}

/** Prefers `GET /api/events` (SSE); polls `/api/log/tail?since=<cursor>`
 *  every {@link LOG_POLL_MS} whenever SSE has not (yet, or no longer)
 *  confirmed itself up, so the very first second and any SSE hiccup are
 *  still covered. Kept as one `useQuery` under the `"log-tail"` key (rather
 *  than a bare `useEffect` poll) so `ui/src/actions/registry.ts`'s
 *  post-write `invalidateQueries({queryKey:["log-tail"]})` still forces an
 *  immediate refetch while polling is the active source. */
export const useLog = (): LogFeedState => {
  const [rows, setRows] = useState<readonly LogEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [sse, setSse] = useState<"connecting" | "up" | "down">(USING_MOCK ? "down" : "connecting");
  const cursorRef = useRef(0);

  /** Idempotent under races between the SSE stream and the poll fallback:
   *  only rows past the cursor we already hold are kept. */
  const append = useCallback((incoming: readonly LogEntry[], newCursor: number): void => {
    const known = cursorRef.current;
    const fresh = incoming.filter((r) => r.seq > known);
    if (fresh.length > 0) {
      setRows((prev) => {
        const merged = prev.concat(fresh);
        return merged.length > LOG_FEED_MAX_ROWS ? merged.slice(merged.length - LOG_FEED_MAX_ROWS) : merged;
      });
    }
    if (newCursor > cursorRef.current) {
      cursorRef.current = newCursor;
      setCursor(newCursor);
    }
  }, []);

  useEffect(() => {
    if (USING_MOCK || typeof EventSource === "undefined") return undefined;
    const es = new EventSource(`${API_BASE}/api/events`);
    const onLog = (ev: MessageEvent<string>): void => {
      try {
        const data = JSON.parse(ev.data) as LogTail;
        append(data.rows, data.cursor);
        setSse("up");
      } catch {
        // malformed frame — ignore, the poll fallback below still runs.
      }
    };
    es.addEventListener("log", onLog as EventListener);
    es.onopen = () => setSse("up");
    es.onerror = () => setSse("down");
    return () => es.close();
  }, [append]);

  const pollEnabled = sse !== "up";
  useQuery({
    queryKey: ["log-tail"],
    queryFn: () => api.logTail(cursorRef.current).then((res) => {
      append(res.rows, res.cursor);
      return res;
    }),
    enabled: pollEnabled,
    refetchInterval: pollEnabled ? LOG_POLL_MS : false,
  });

  return { rows, cursor, connected: sse === "up" ? "sse" : sse === "down" ? "poll" : "connecting" };
};

export const useSearchFunctions = (query: string): UseQueryResult<SearchPage<FunctionMatch>> =>
  useQuery({ queryKey: ["search-functions", query], queryFn: () => api.searchFunctions(query), enabled: query.length > 0 });

// -- listing (wave 2 track 1) ------------------------------------------------

/** `GET /api/module/:id/source` — the file view. 404 when the module has no
 *  file, which is an empty listing rather than an error (`isMissingResource`). */
export const useModuleSource = (id: number): UseQueryResult<ModuleSource> =>
  useQuery({ queryKey: ["module-source", id], queryFn: () => api.moduleSource(id), staleTime: Infinity, ...perFn(id) });

/** The same file view for several modules at once — the left pane expands
 *  more than one module and needs each one's function list. `useQueries`
 *  keeps this legal as the open set changes. */
export const useModuleSources = (ids: readonly number[]): ReadonlyMap<number, ModuleSource> => {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["module-source", id],
      queryFn: () => api.moduleSource(id),
      staleTime: Infinity,
      retry: retryServerErrorsOnly,
    })),
  });
  const out = new Map<number, ModuleSource>();
  for (const [i, r] of results.entries()) {
    const id = ids[i];
    if (id !== undefined && r.data !== undefined) out.set(id, r.data);
  }
  return out;
};

/** `GET /api/modules`. The module catalogue changes only when the project is
 *  re-decompiled, so it never refetches on focus. */
export const useModules = (): UseQueryResult<ModuleListPage> =>
  useQuery({ queryKey: ["modules"], queryFn: () => api.modules(), staleTime: Infinity });

/** The page size requested per `/api/functions` call — up to
 *  `FUNCTIONS_PAGE_MAX` (1000, `src/ui-server/list.ts`) rather than the
 *  route's 50-row default, so the whole catalogue walk below is a handful
 *  of requests instead of hundreds. */
export const FUNCTION_CATALOGUE_PAGE_SIZE = 1000;

/** How many pages of `/api/functions` the tree will walk before giving up —
 *  at {@link FUNCTION_CATALOGUE_PAGE_SIZE} a page this is 200 000 functions,
 *  well past any real bundle (Service NSW's ~15 000 is 15 pages); past that
 *  the caller shows what it has and says so via `incomplete`. This used to
 *  be a real ceiling (200 pages of 50 = 10 000, less than NSW's ~15 000
 *  functions, silently dropping a third of them) — raising the page size
 *  is what actually lifted the cap, this is just a runaway guard now. */
export const FUNCTION_PAGE_LIMIT = 200;

export interface FunctionCatalogue {
  readonly rows: readonly FunctionListRow[];
  readonly total: number;
  /** True when the walk stopped at FUNCTION_PAGE_LIMIT with pages left. */
  readonly incomplete: boolean;
}

/** The whole function catalogue, paged through `nextCursor`. One query, so
 *  every module in the tree reads the same cached array. */
export const useFunctionCatalogue = (): UseQueryResult<FunctionCatalogue> =>
  useQuery({
    queryKey: ["functions-all"],
    staleTime: Infinity,
    queryFn: async (): Promise<FunctionCatalogue> => {
      const rows: FunctionListRow[] = [];
      let cursor: number | undefined = 0;
      let total = 0;
      for (let page = 0; page < FUNCTION_PAGE_LIMIT; page += 1) {
        const p: FunctionListPage = await api.functions(cursor, FUNCTION_CATALOGUE_PAGE_SIZE);
        rows.push(...p.rows);
        total = p.total;
        if (p.nextCursor === null) return { rows, total, incomplete: false };
        cursor = p.nextCursor;
      }
      return { rows, total, incomplete: true };
    },
  });
