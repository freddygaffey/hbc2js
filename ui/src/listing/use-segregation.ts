// ui/src/listing/use-segregation.ts — `GET /api/segregation` as a query.
//
// Its own file rather than a line in ui/src/hooks.ts because the answer is
// computed once per SERVER process (segregating a 4,510-module bundle costs
// seconds, not milliseconds) and is therefore immutable for the lifetime of
// the page: `staleTime: Infinity`, no refetch on focus, no retry — a failure
// means "no segregation", which `groupModulesSegregated` already handles by
// falling back to the flat `groupModules` tree.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchSegregation, type SegregationPage } from "./wire.ts";

export const useSegregation = (): UseQueryResult<SegregationPage | null> =>
  useQuery({
    queryKey: ["segregation"],
    queryFn: () => fetchSegregation(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
