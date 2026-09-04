// ui/src/workers/hooks.ts — TanStack Query over ./wire.ts. The jobs rail and
// the presence chips poll on a short interval (spec 22 §1's MVP default is
// polling; the SSE `event: worker` channel exists server-side and is the
// upgrade path, not a requirement); suggestions are invalidated by the
// actions that change them rather than polled hard.
import { useMutation, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { workersApi, WorkersUnavailable, type JobsResult, type SessionsResult, type SuggestionsResult } from "./wire.ts";

/** Fast enough that a queued job visibly starts, cheap enough to leave on:
 *  each poll is one indexed SELECT on a table with tens of rows. */
export const JOBS_POLL_MS = 1000;
export const PRESENCE_POLL_MS = 5000;

/** Never retry a 503 — "workers are off" is a settled answer, not a blip. */
const noRetryWhenOff = (count: number, error: Error): boolean => !(error instanceof WorkersUnavailable) && count < 1;

export const useJobs = (): UseQueryResult<JobsResult> =>
  useQuery({ queryKey: ["jobs"], queryFn: () => workersApi.jobs(), refetchInterval: JOBS_POLL_MS, retry: noRetryWhenOff });

export const useSessions = (): UseQueryResult<SessionsResult> =>
  useQuery({ queryKey: ["sessions"], queryFn: () => workersApi.sessions(), refetchInterval: PRESENCE_POLL_MS, retry: noRetryWhenOff });

export const useSuggestions = (fn: number | undefined): UseQueryResult<SuggestionsResult> =>
  useQuery({
    queryKey: ["suggestions", fn ?? null],
    queryFn: () => workersApi.suggestions(fn),
    refetchInterval: JOBS_POLL_MS,
    retry: noRetryWhenOff,
  });

/** Everything a finished job / a promotion changes. `invalidateFn` in
 *  ui/src/actions/registry.ts covers the fn's own resources; this covers the
 *  worker-owned ones. */
export function invalidateWorkers(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["jobs"] });
  void qc.invalidateQueries({ queryKey: ["suggestions"] });
}

export function useEnqueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, input }: { readonly kind: string; readonly input: Record<string, unknown> }) => workersApi.enqueue(kind, input),
    onSuccess: () => invalidateWorkers(qc),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => workersApi.cancel(id), onSuccess: () => invalidateWorkers(qc) });
}

export function usePromote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, rid }: { readonly target: string; readonly rid: string }) => workersApi.promote(target, rid),
    onSuccess: () => invalidateWorkers(qc),
  });
}

export function useReject() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (rid: string) => workersApi.reject(rid), onSuccess: () => invalidateWorkers(qc) });
}
