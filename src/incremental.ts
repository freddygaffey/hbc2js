// src/incremental.ts — the cooperative driver for whole-bundle scans that
// must not freeze the ui-server's single thread.
//
// Node's http server runs on one event loop: any handler that computes
// inline head-of-line-blocks EVERY other route behind it. `GET
// /api/search/source` did exactly that -- 83 s on a real 12 MB app, during
// which seven `/api/jobs` probes issued over 70 s all timed out and then
// completed in 0 ms the instant the search returned (docs/BUGS.md
// "search/source blocks the ui-server" row).
//
// `src/workers/leads-worker.ts` solves the same problem with a
// `node:worker_threads` worker, which is right for a compute whose input is
// just `artifactDir` (`computeLeads`). It is the WRONG shape for a search:
// the worker would rebuild an `ArtifactService` per query (seconds), and it
// would answer without the caller's overlay names, so a renamed function
// would silently match on its pre-rename text. This driver takes the other
// standard route instead: the scan is written ONCE as a generator that
// `yield`s between units of work, and is then drained either synchronously
// (MCP/CLI callers, unchanged semantics) or asynchronously, handing the
// event loop back every {@link YIELD_SLICE_MS} so every other request keeps
// answering while the scan runs. Same answer either way -- the generator is
// the single implementation.
import { setImmediate as scheduleImmediate } from "node:timers";

/** A scan expressed as steps: `yield` between units of work, `return` the
 *  finished result. `void` in both directions -- a step carries no value,
 *  the result comes back through the generator's return type. */
export type Steps<T> = Generator<void, T, void>;

/** How long a drained scan may hold the event loop before yielding it.
 *  8 ms keeps a concurrent request's added latency inside one animation
 *  frame while leaving the per-yield overhead (a `setImmediate` round trip,
 *  ~0.05 ms) under 1% of the scan's own cost. */
export const YIELD_SLICE_MS = 8;

/** Runs the scan straight through, no yielding -- for callers that are not
 *  on a shared event loop (CLI verbs, MCP stdio, tests). */
export function drainSync<T>(steps: Steps<T>): T {
  let r = steps.next();
  while (r.done !== true) r = steps.next();
  return r.value;
}

/** Runs the scan, handing the event loop back every {@link YIELD_SLICE_MS}.
 *  The result is identical to {@link drainSync}'s -- only the scheduling
 *  differs. */
export async function drainAsync<T>(steps: Steps<T>, sliceMs: number = YIELD_SLICE_MS): Promise<T> {
  let deadline = performance.now() + sliceMs;
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => {
        scheduleImmediate(resolve);
      });
      deadline = performance.now() + sliceMs;
    }
  }
}
