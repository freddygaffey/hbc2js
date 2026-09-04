// ui/src/hooks.ts — TanStack Query hooks over ./api.ts. One hook per
// resource; components never call fetch directly. Query keys are
// `[resource, ...args]` so a write (spec 22 landing 5) can invalidate
// precisely, and the log poll (landing 6) has its own 1 s interval.
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, ApiError } from "./api.ts";
import type { FunctionListPage, FunctionListRow, ModuleListPage } from "./listing/wire.ts";
import type {
  Bounded, CallsFrom, FnContext, FnSummary, FunctionMatch, LeadsResult, LogTail,
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

/** Spec 22 §1/§3.5: the MVP live-update wire is a 1 s poll of
 *  `/api/log/tail?since=<seq>`. The shell polls from seq 0 (the whole tail,
 *  capped server-side); incremental cursor advance is landing 6's job. */
export const useLog = (since = 0): UseQueryResult<LogTail> =>
  useQuery({ queryKey: ["log-tail", since], queryFn: () => api.logTail(since), refetchInterval: LOG_POLL_MS });

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

/** How many 50-row pages of `/api/functions` the tree will walk. 200 pages =
 *  10 000 functions, which is more than the left pane can usefully show
 *  without virtualisation (spec 22 §2 accepts no virtualisation for the MVP);
 *  past that the tree shows what it has and says so. */
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
        const p: FunctionListPage = await api.functions(cursor);
        rows.push(...p.rows);
        total = p.total;
        if (p.nextCursor === null) return { rows, total, incomplete: false };
        cursor = p.nextCursor;
      }
      return { rows, total, incomplete: true };
    },
  });
