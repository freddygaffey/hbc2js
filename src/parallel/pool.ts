// docs/perf/PARALLEL-DECOMPILE.md — part 1: worker pool across function
// ranges for the stage-A pass pipeline. See the design note for the
// determinism/soundness argument; this file is the mechanism only.
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { StageAResult, WorkerRequest, WorkerResponse } from "./types.ts";

/** `HBC2JS_WORKERS` env override; default `max(1, cpus - 2)` (headroom for
 *  a fuzz campaign or the OS on the same box, per the brief). `1` is the
 *  exact serial path — callers must check this and skip the pool entirely
 *  rather than spawn a single worker, so `workers=1` is byte-identical to
 *  `decompile()` by construction, not by convergence. */
export function resolveWorkerCount(explicit?: number): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  const envVal = process.env.HBC2JS_WORKERS;
  if (envVal !== undefined && envVal.trim().length > 0) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(1, cpus().length - 2);
}

/** Round-robin, not contiguous ranges: `--split`'s evidence is that cost is
 *  driven by pass-matcher hits, not function size, and function size/cost
 *  correlates with position in a bundle (large "vendor" modules cluster);
 *  round-robin spreads that more evenly than a contiguous slice per worker. */
function assign(indices: readonly number[], workerCount: number): number[][] {
  const buckets: number[][] = Array.from({ length: workerCount }, () => []);
  indices.forEach((i, n) => buckets[n % workerCount]!.push(i));
  return buckets;
}

const WORKER_SCRIPT = fileURLToPath(new URL("./stage-a-worker.ts", import.meta.url));

/**
 * Runs stage-A (`structure()` + the D12 pass pipeline) for every index in
 * `indices` across a pool of `workerCount` worker threads, each an
 * independent `parseHbc`/`analyseModule` of `bytes` (no shared mutable
 * state — see the design note). Rejects loudly on any worker `error`/crash,
 * tearing every other worker down first — never returns a partial result.
 */
export async function runStageAPool(
  bytes: Uint8Array,
  indices: readonly number[],
  req: Omit<WorkerRequest, "bytes" | "indices">,
  workerCount: number,
): Promise<Map<number, StageAResult>> {
  const buckets = assign(indices, workerCount).filter((b) => b.length > 0);
  const workers: Worker[] = [];
  let settled = false;

  const results = new Map<number, StageAResult>();

  try {
    await new Promise<void>((resolve, reject) => {
      let remaining = buckets.length;
      if (remaining === 0) {
        resolve();
        return;
      }
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      for (const bucket of buckets) {
        const worker = new Worker(WORKER_SCRIPT, {
          workerData: { ...req, bytes, indices: bucket } satisfies WorkerRequest,
        });
        workers.push(worker);
        worker.once("message", (msg: WorkerResponse) => {
          if (!msg.ok) {
            fail(new Error(`hbc2js parallel decompile: worker failed: ${msg.error.message}${msg.error.stack ? `\n${msg.error.stack}` : ""}`));
            return;
          }
          for (const r of msg.results) results.set(r.index, r);
          remaining--;
          if (remaining === 0 && !settled) {
            settled = true;
            resolve();
          }
        });
        worker.once("error", (err) => fail(err));
        worker.once("exit", (code) => {
          if (code !== 0 && !settled) fail(new Error(`hbc2js parallel decompile: worker exited with code ${code}`));
        });
      }
    });
  } finally {
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
  }
  return results;
}
