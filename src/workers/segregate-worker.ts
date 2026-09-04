// src/workers/segregate-worker.ts — off-main-thread compute for
// `GET /api/segregation` (docs/UI.md segregation route). The ui-server's
// event loop must never block on `segregateSplitTree` (measured 5 s
// isolated, 37-70 s loaded on a 4.5k-module bundle — every OTHER route was
// unresponsive for that whole window before this file existed); this
// worker runs the exact same `segregationOf` (`src/ui-server/
// segregation.ts`, imported, never reimplemented here) on its own thread
// and posts the plain-JSON-able `SegregationResult | null` back over
// `parentPort`. No other side effect: this worker never touches the
// project DB — the parent (`segregation.ts`) persists the result once it
// receives it, so a worker crash mid-write can never corrupt the cache.
import { parentPort, workerData } from "node:worker_threads";
import { segregationOf } from "../ui-server/segregation.ts";
import type { DepsReport } from "../deps/report.ts";

/** `workerData` shape `runSegregateWorker` (segregation.ts) sends. */
export interface SegregateWorkerInput {
  readonly artifactDir: string;
  readonly deps: DepsReport | null;
  readonly depsApplied: boolean;
}

export type SegregateWorkerMessage =
  | { readonly ok: true; readonly result: ReturnType<typeof segregationOf> }
  | { readonly ok: false; readonly error: string };

if (parentPort !== null) {
  const input = workerData as SegregateWorkerInput;
  try {
    const result = segregationOf(input.artifactDir, input.deps, input.depsApplied);
    const msg: SegregateWorkerMessage = { ok: true, result };
    parentPort.postMessage(msg);
  } catch (err) {
    const msg: SegregateWorkerMessage = { ok: false, error: err instanceof Error ? err.message : String(err) };
    parentPort.postMessage(msg);
  }
}
