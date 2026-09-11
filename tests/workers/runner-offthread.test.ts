// tests/workers/runner-offthread.test.ts -- regression for the docs/BUGS.md
// 2026-09-11 row "readability jobs block the ui-server event loop"
// (docs/DECISIONS.md D24).
//
// Before the fix, `WorkerRunner.runReadabilityJob` called `suggestNames`
// inline: measured 55.8 s of UNINTERRUPTED main-thread work for a single
// `{fn:0}` job over tests/fixtures/bundles/rn-template-0.72/
// index.android.hbc with the offline `heuristic` backend, during which every
// other HTTP route head-of-line-blocked (that is what makes
// `ui/e2e/recompile.spec.ts`'s two cases time out on `/api/modules` right
// after `ui/e2e/readability.spec.ts` enqueues a job). After the fix the same
// job runs in `src/workers/readability-worker.ts`.
//
// Two tests, deliberately split by cost:
//  1. ALWAYS: the off-thread path and the in-process path
//     (`HBC2JS_READABILITY_INPROCESS=1`) produce the same job result and the
//     same name-overlay sidecar, over a construct fixture (~0.1 s each), plus
//     the worker module answers when spawned directly.
//  2. TIER-GATED (`HBC2JS_TIER=all`, or `HBC2JS_OFFTHREAD_STALL=1`): the
//     latency assertion itself, over rn-template-0.72. It costs ~60 s of
//     wall time because the JOB costs that -- see docs/PUSHBACK.md P-64 for
//     why it is not in the default gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { repoRoot } from "../support/paths.ts";
import { startUiServer, type UiServerHandle } from "../../src/ui-server/server.ts";
import { READABILITY_INPROCESS_ENV } from "../../src/workers/runner.ts";
import type { ReadabilityWorkerInput, ReadabilityWorkerMessage } from "../../src/workers/readability-worker.ts";

const SMALL_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const BIG_HBC = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const WORKER_SCRIPT = fileURLToPath(new URL("../../src/workers/readability-worker.ts", import.meta.url));
const OVERLAY = "readability-overlay.names.json";

/** Mirrors `src/cli.ts`'s `runInit`, exactly as
 *  `tests/ui-server/server-readability.test.ts` does. */
function buildProject(hbcPath: string, moduleName: string): string {
  const bytes = readFileSync(hbcPath);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-offthread-"));
  const splitResult = splitProject(bytes, { moduleName });
  writeSplitResult(splitResult, join(outDir, "src"));
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

function url(h: UiServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`;
}

async function withServer(hbcPath: string, moduleName: string, run: (h: UiServerHandle, outDir: string) => Promise<void>): Promise<void> {
  const outDir = buildProject(hbcPath, moduleName);
  const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", hbc: hbcPath, prewarm: false, noAuth: true, llmBackend: "heuristic" });
  try {
    await run(h, outDir);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function enqueueSuggestNames(h: UiServerHandle, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(url(h, "/api/readability/actions/suggest-names"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(res.status, 202, "suggest-names must enqueue (spec 28 landing 4d)");
  return ((await res.json()) as { jobId: string }).jobId;
}

interface JobRow {
  readonly id: string;
  readonly status: string;
  readonly result?: unknown;
  readonly error?: string | null;
}

async function jobRow(h: UiServerHandle, jobId: string): Promise<JobRow | undefined> {
  const { rows } = (await (await fetch(url(h, "/api/jobs"))).json()) as { rows: readonly JobRow[] };
  return rows.find((r) => r.id === jobId);
}

async function pollJobDone(h: UiServerHandle, jobId: string, timeoutMs: number): Promise<JobRow> {
  const start = Date.now();
  for (;;) {
    const job = await jobRow(h, jobId);
    if (job !== undefined && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not finish within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The overlay sidecar with the fields that are timestamps or derived from
 *  them removed, so two runs of the SAME pass compare equal. */
function normalisedOverlay(outDir: string): unknown {
  const raw = JSON.parse(readFileSync(join(outDir, OVERLAY), "utf8")) as { readonly records?: readonly Record<string, unknown>[] };
  return (raw.records ?? []).map(({ rid, ts, supersedes, ...rest }) => {
    void rid;
    void ts;
    void supersedes;
    return rest;
  });
}

/** The job result minus `equiv.ts` (a wall-clock stamp). */
function normalisedResult(result: unknown): unknown {
  const r = result as { readonly equiv?: Record<string, unknown> };
  return { ...(r as Record<string, unknown>), equiv: { ...(r.equiv ?? {}), ts: "<ts>" } };
}

async function runOnce(inProcess: boolean): Promise<{ readonly result: unknown; readonly overlay: unknown }> {
  const previous = process.env[READABILITY_INPROCESS_ENV];
  if (inProcess) process.env[READABILITY_INPROCESS_ENV] = "1";
  else delete process.env[READABILITY_INPROCESS_ENV];
  try {
    let out: { result: unknown; overlay: unknown } | undefined;
    await withServer(SMALL_HBC, "04-for-loop-basic", async (h, outDir) => {
      const jobId = await enqueueSuggestNames(h, { module: 0 });
      const job = await pollJobDone(h, jobId, 30_000);
      assert.equal(job.status, "done", `suggest-names must finish (inProcess=${String(inProcess)}): ${String(job.error)}`);
      out = { result: normalisedResult(job.result), overlay: normalisedOverlay(outDir) };
    });
    return out!;
  } finally {
    if (previous === undefined) delete process.env[READABILITY_INPROCESS_ENV];
    else process.env[READABILITY_INPROCESS_ENV] = previous;
  }
}

test("the off-thread readability worker produces the same result and the same overlay sidecar as the in-process path", async () => {
  const off = await runOnce(false);
  const inp = await runOnce(true);
  assert.deepEqual(off.result, inp.result, "moving suggest_names to a worker thread must not change what the job returns");
  assert.deepEqual(off.overlay, inp.overlay, "the name-overlay sidecar written from the worker must match the in-process one");
});

test("src/workers/readability-worker.ts answers when spawned directly, with no project DB connection of its own", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-offthread-direct-"));
  try {
    const input: ReadabilityWorkerInput = {
      hbcPath: SMALL_HBC,
      projectDir: outDir,
      treeDir: outDir,
      backendId: "heuristic",
      surface: "ui",
      args: { target: { module: 0 } },
    };
    const msg = await new Promise<ReadabilityWorkerMessage>((resolve, reject) => {
      const w = new Worker(WORKER_SCRIPT, { workerData: input });
      w.once("message", (m: ReadabilityWorkerMessage) => {
        void w.terminate();
        resolve(m);
      });
      w.once("error", reject);
    });
    assert.equal(msg.ok, true, `worker failed: ${msg.ok ? "" : msg.error}`);
    const result = (msg as { readonly result: { readonly equiv: { readonly verdict: string }; readonly txIds: readonly string[] } }).result;
    assert.equal(result.equiv.verdict, "PASS");
    // P-59 / spec 18 sections 5-6: a name proposal has no transaction, which
    // is exactly why this worker never opens the project DB and cannot
    // become a second writer on the hash-chained log.
    assert.deepEqual(result.txIds, []);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

const stallTier = process.env["HBC2JS_TIER"] === "all" || process.env["HBC2JS_OFFTHREAD_STALL"] === "1";

test(
  "a suggest-names job over a real bundle never stalls the ui-server: every /api/modules answers inside 1 s",
  { skip: stallTier ? false : "cost: ~60 s (the job itself); run with HBC2JS_TIER=all or HBC2JS_OFFTHREAD_STALL=1 -- docs/PUSHBACK.md P-64" },
  async () => {
    await withServer(BIG_HBC, "rn-template", async (h) => {
      const jobId = await enqueueSuggestNames(h, { fn: 0 });
      let worst = 0;
      let probes = 0;
      const started = Date.now();
      for (;;) {
        const t0 = Date.now();
        const res = await fetch(url(h, "/api/modules"));
        const dt = Date.now() - t0;
        assert.equal(res.status, 200);
        await res.arrayBuffer();
        worst = Math.max(worst, dt);
        probes++;
        const job = await jobRow(h, jobId);
        if (job !== undefined && job.status !== "queued" && job.status !== "running") {
          assert.equal(job.status, "done", `job must finish: ${String(job.error)}`);
          break;
        }
        if (Date.now() - started > 300_000) throw new Error("suggest-names job did not finish within 300 s");
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(probes > 20, `expected the probe loop to run many times while the job ran, got ${String(probes)}`);
      assert.ok(worst < 1000, `worst /api/modules latency while a suggest-names job ran was ${String(worst)} ms (was one ~56 s stall before the fix)`);
    });
  },
);
