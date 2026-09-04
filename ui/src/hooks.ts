// ui/src/hooks.ts — TanStack Query hooks over ./api.ts. One hook per
// resource; components never call fetch directly. Query keys are
// `[resource, ...args]` so a write (spec 22 landing 5) can invalidate
// precisely, and the log poll (landing 6) has its own 1 s interval.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "./api.ts";
import type {
  Bounded, CallsFrom, FnContext, FnSummary, FunctionMatch, LeadsResult, LogTail,
  ModuleInfo, PackageIdResult, ResolvedFinding, SearchPage, SourceText, WhoCalls,
} from "./contracts.ts";

export const LOG_POLL_MS = 1000;

export const useFn = (fn: number): UseQueryResult<FnSummary> =>
  useQuery({ queryKey: ["fn", fn], queryFn: () => api.fn(fn) });

export const useSource = (fn: number): UseQueryResult<SourceText> =>
  useQuery({ queryKey: ["source", fn], queryFn: () => api.source(fn) });

export const useDisasm = (fn: number): UseQueryResult<SourceText> =>
  useQuery({ queryKey: ["disasm", fn], queryFn: () => api.disasm(fn) });

export const useContextResource = (fn: number): UseQueryResult<FnContext> =>
  useQuery({ queryKey: ["context", fn], queryFn: () => api.context(fn) });

export const useWhoCalls = (fn: number): UseQueryResult<WhoCalls> =>
  useQuery({ queryKey: ["who-calls", fn], queryFn: () => api.whoCalls(fn) });

export const useCallsFrom = (fn: number): UseQueryResult<CallsFrom> =>
  useQuery({ queryKey: ["calls-from", fn], queryFn: () => api.callsFrom(fn) });

export const useModule = (id: number): UseQueryResult<ModuleInfo> =>
  useQuery({ queryKey: ["module", id], queryFn: () => api.module(id) });

export const usePackageId = (mod: number): UseQueryResult<PackageIdResult> =>
  useQuery({ queryKey: ["package-id", mod], queryFn: () => api.packageId(mod) });

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
