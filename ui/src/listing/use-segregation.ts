// ui/src/listing/use-segregation.ts — `GET /api/segregation` as a query.
//
// Its own file rather than a line in ui/src/hooks.ts because the answer is
// computed once per SERVER process (segregating a 4,510-module bundle costs
// seconds, not milliseconds) and is therefore near-immutable for the
// lifetime of the page: `staleTime: Infinity`, no refetch on focus, no
// retry — a failure means "no segregation", which `groupModulesSegregated`
// already handles by falling back to the flat `groupModules` tree.
//
// Two exceptions to "immutable", both re-polled rather than treated as
// final:
//
// - `computing: true` — the server's off-main-thread compute
//   (`src/ui-server/segregation.ts`, `node:worker_threads`) has not landed
//   yet, so `modules`/`counts` are the empty/zero placeholder shape. Polled
//   fast (`COMPUTING_POLL_MS`): this is the SAME window that used to block
//   the whole server before the segcache work, so a real app now sees an
//   empty tree for at most a couple of poll cycles instead of a hung
//   request.
// - `depsApplied: false` — the server's FIRST *settled* snapshot is warmed
//   before the async `deps` run (`applyDepsWhenReady`) has had a chance to
//   finish, so third-party modules are not yet filed under
//   `node_modules/<pkg>/…`. Polled slower (`DEPS_POLL_MS`).
//
// `refetchInterval` re-polls while either is true and stops (`false`
// return) once both have settled — a real interval, not `staleTime`,
// because a cached-but-stale answer would otherwise never be asked for
// again.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchSegregation, type SegregationPage } from "./wire.ts";

const COMPUTING_POLL_MS = 500;
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
      if (data.computing === true) return COMPUTING_POLL_MS;
      return data.depsApplied ? false : DEPS_POLL_MS;
    },
  });
