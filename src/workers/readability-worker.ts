// src/workers/readability-worker.ts -- off-main-thread compute for the
// `readability-suggest-names` job kind (docs/BUGS.md 2026-09-11 row
// "readability jobs block the ui-server event loop", docs/DECISIONS.md D24).
//
// `WorkerRunner.runReadabilityJob` used to call `suggestNames`
// (src/readability/surfaces.ts) inline on the ui-server's single event loop.
// After the analysis pool landed, `loadAnalysis` is async and cached, but
// everything after it is one synchronous main-thread burst: `rawFrameBodies`
// re-runs `emitModule` over the whole bundle, and `nameableTargets` then
// calls `NameService.render({fn})` -- another whole-module emit -- ONCE PER
// NAMEABLE REGISTER. Measured on the e2e rig (rn-template-0.72, a
// `{module}` target): every HTTP request behind it stalls for the whole
// job, which is what makes `ui/e2e/recompile.spec.ts` time out on
// `/api/modules` right after `ui/e2e/readability.spec.ts` enqueues a job.
// `src/workers/leads-worker.ts` solves the identical problem the identical
// way for `computeLeads`; this file is that pattern for the readability
// surface.
//
// **Why this worker never opens the project DB (spec 18 sections 5-6).**
// Spec 18's write path is DB-first and its `log/` is HASH-CHAINED: an
// appender reads the previous entry's hash and then appends, which is not
// atomic across two connections. A second writing connection would therefore
// be able to fork the chain and make `hbcproj verify --full` fail. So this
// worker opens NO project connection at all: it builds the
// `ReadabilityContext` with an in-memory placeholder handle, which is sound
// precisely because `suggestNames` touches `ctx.db` nowhere -- P-59 put name
// proposals in the per-project name-overlay sidecar, not in `readability_tx`
// (`suggest_names`'s `txIds` is documented as always empty). The two kinds
// that DO go through `recordTransaction` (`readability-rewrite-function`,
// `readability-combine-files`) therefore stay on the main thread, where the
// single writer lives; see the BUGS.md follow-up row for their own stall.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { backendForId, resolveBackendId } from "../readability/backends.ts";
import { suggestNames, ReadabilitySurfaceError, type ReadabilityContext, type SuggestNamesArgs } from "../readability/surfaces.ts";
import { TransactionRefused } from "../readability/transactions.ts";
import { TransientBackendError } from "./backend.ts";
import type { CallSurface } from "../readability/types.ts";

/** Everything the worker needs to REBUILD the context rather than receive
 *  it: a `ReadabilityContext` carries a live `DatabaseSync` handle and a
 *  `WorkerBackend` instance, neither of which is structured-clone-safe. The
 *  backend comes back from its id through `backendForId` -- the one place
 *  spec 28 section 9.1 maps an id to a constructor -- so the worker's
 *  backend is the same object the main thread would have built. */
export interface ReadabilityWorkerInput {
  readonly hbcPath: string;
  readonly projectDir: string;
  readonly treeDir: string;
  readonly backendId: string;
  readonly overlayPath?: string;
  readonly who?: string;
  readonly surface?: CallSurface;
  readonly args: SuggestNamesArgs;
}

/** `transient` is computed HERE because only the worker still has the error
 *  object: `WorkerRunner`'s `instanceof` checks cannot survive the thread
 *  boundary, and a retryable backend hiccup must not be confused with a
 *  refused gate (which is a normal, reported outcome, never retried). */
export type ReadabilityWorkerMessage =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string; readonly transient: boolean };

function isTransient(err: unknown): boolean {
  if (!(err instanceof TransientBackendError)) return false;
  return !(err instanceof ReadabilitySurfaceError || err instanceof TransactionRefused);
}

export async function runSuggestNamesInWorker(input: ReadabilityWorkerInput): Promise<ReadabilityWorkerMessage> {
  // See the file header: an in-memory handle, never the project's. If a
  // future `suggestNames` ever reads the project DB this fails loudly (empty
  // schema) instead of silently becoming a second writer.
  const db = new DatabaseSync(":memory:");
  try {
    const ctx: ReadabilityContext = {
      db,
      projectDir: input.projectDir,
      treeDir: input.treeDir,
      backend: backendForId(resolveBackendId(input.backendId, {}), { env: process.env, projectDir: input.projectDir }),
      hbcPath: input.hbcPath,
      ...(input.overlayPath !== undefined ? { overlayPath: input.overlayPath } : {}),
      ...(input.who !== undefined ? { who: input.who } : {}),
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
    };
    const result = await suggestNames(ctx, input.args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), transient: isTransient(err) };
  } finally {
    db.close();
  }
}

if (parentPort !== null && workerData !== null && workerData !== undefined) {
  const port = parentPort;
  void runSuggestNamesInWorker(workerData as ReadabilityWorkerInput).then((msg) => {
    port.postMessage(msg);
  });
}
