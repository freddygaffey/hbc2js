// ui/src/listing/use-segregation.ts — `GET /api/segregation` as a query.
//
// Its own file rather than a line in ui/src/hooks.ts because the answer is
// computed once per SERVER process (segregating a 4,510-module bundle costs
// seconds, not milliseconds) and is therefore near-immutable for the
// lifetime of the page: `staleTime: Infinity`, no refetch on focus, no
// retry — a failure means "no segregation", which `groupModulesSegregated`
// already handles by falling back to the flat `groupModules` tree.
//
// One exception to "immutable": the server's FIRST snapshot has
// `depsApplied: false` (it is warmed before the async `deps` run — src/ui-
// server/segregation.ts's `applyDepsWhenReady` — has had a chance to
// finish), so third-party modules are not yet filed under
// `node_modules/<pkg>/…`. `refetchInterval` re-polls every 5 s while that
// is `false` and stops (`false` return) once the server flips it to `true`
// — a real interval, not `staleTime`, because a cached-but-stale answer
// would otherwise never be asked for again.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchSegregation, type SegregationPage } from "./wire.ts";

const DEPS_POLL_MS = 5000;

export const useSegregation = (): UseQueryResult<SegregationPage | null> =>
  useQuery({
    queryKey: ["segregation"],
    queryFn: () => fetchSegregation(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || data === null) return false;
      return data.depsApplied ? false : DEPS_POLL_MS;
    },
  });
