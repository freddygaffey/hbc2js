// ui/src/listing/use-screens.ts — `GET /api/screens` as a query, alongside
// `use-segregation.ts` and for the same reason: the answer is computed once
// per SERVER process and is near-immutable for the life of the page, except
// while the segregation it derives from is still computing.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE, USING_MOCK } from "../api.ts";
import type { ScreensPage } from "./screens.ts";

/** `GET /api/screens`. `null` (mock mode, 404, a server without the route)
 *  leaves the left pane on the flat segregated grouping — the tree is never
 *  blank because this landing's route is missing. Lives here, not in the
 *  pure `screens.ts`, so the gate can import that model with no fetch/env
 *  dependency at all. */
export async function fetchScreens(): Promise<ScreensPage | null> {
  if (USING_MOCK) return null;
  const res = await fetch(`${API_BASE}/api/screens`);
  if (!res.ok) return null;
  return (await res.json()) as ScreensPage;
}

const COMPUTING_POLL_MS = 500;

export const useScreens = (): UseQueryResult<ScreensPage | null> =>
  useQuery({
    queryKey: ["screens"],
    queryFn: () => fetchScreens(),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || data === null) return false;
      return data.computing === true ? COMPUTING_POLL_MS : false;
    },
  });
