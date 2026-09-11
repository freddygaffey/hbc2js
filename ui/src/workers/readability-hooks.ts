// ui/src/workers/readability-hooks.ts — TanStack Query over
// ./readability-wire.ts, same shape as ./hooks.ts. Suggestions poll on the
// same short interval the jobs rail uses (spec 22 §1's MVP default is
// polling); every mutation invalidates the one query key so a promote/
// revert/action is visible on the very next render.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  readabilityApi,
  ReadabilityUnavailable,
  type ReadabilityFilter,
  type ReadabilitySuggestionsResult,
} from "./readability-wire.ts";

export const READABILITY_POLL_MS = 2000;

const noRetryWhenOff = (count: number, error: Error): boolean => !(error instanceof ReadabilityUnavailable) && count < 1;

export const READABILITY_QUERY_KEY = "readability-suggestions";

export function useReadabilitySuggestions(filter: ReadabilityFilter, limit?: number): UseQueryResult<ReadabilitySuggestionsResult> {
  return useQuery({
    queryKey: [READABILITY_QUERY_KEY, filter, limit ?? null],
    queryFn: () => readabilityApi.suggestions(filter, limit),
    refetchInterval: READABILITY_POLL_MS,
    retry: noRetryWhenOff,
  });
}

export function useInvalidateReadability(): () => void {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] });
}

export function usePromoteSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, who }: { readonly id: { readonly txId?: string; readonly suggestionId?: string }; readonly who: string }) =>
      readabilityApi.promote(id, who),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] }),
  });
}

export function useRevertSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: { readonly txId?: string; readonly suggestionId?: string }) => readabilityApi.revert(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] }),
  });
}

export function useSuggestNamesAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { readonly module: number } | { readonly fn: number }) => readabilityApi.suggestNames(target),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] }),
  });
}

export function useRewriteFunctionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fn: number) => readabilityApi.rewriteFunction(fn),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] }),
  });
}

export function useCombineFilesAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ inputs, outputs, evidence }: { readonly inputs: readonly string[]; readonly outputs: readonly string[]; readonly evidence: string }) =>
      readabilityApi.combineFiles(inputs, outputs, evidence),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [READABILITY_QUERY_KEY] }),
  });
}

export function useReviewAction() {
  return useMutation({ mutationFn: () => readabilityApi.review() });
}
