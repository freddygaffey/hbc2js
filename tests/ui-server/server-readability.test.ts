// tests/ui-server/server-readability.test.ts -- spec 28 landing 4d: the
// live-wiring blocker landing 4c's own status paragraph recorded
// (`src/ui-server/server.ts` never built a `ReadabilityRoutesCtx`, so every
// `/api/readability/*` route 503'd under a real `hbc2js ui-server` process
// regardless of fixture). This suite starts the REAL server (`startUiServer`,
// the same function `src/cli.ts ui-server` calls) over a real project built
// the same way `hbc2js init` builds one (split tree at `<projectDir>/src`,
// `project.hbcproj`), with `--llm-backend fake`'s equivalent
// (`llmBackend: "fake"`), and hits every readability route over a real
// socket -- no direct `handle()` call, unlike `readability-routes.test.ts`'s
// pure-function suite, which this one complements rather than replaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { repoRoot } from "../support/paths.ts";
import { startUiServer, type UiServerHandle } from "../../src/ui-server/server.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);

/** Mirrors `src/cli.ts`'s `runInit`: split tree at `<outDir>/src`,
 *  `<outDir>/project.hbcproj` with the ix_* stratum -- the exact shape
 *  `buildReadabilityCtx` (`server.ts`) looks for. */
function buildProject(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-readability-live-"));
  const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
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

async function withServer(run: (h: UiServerHandle) => Promise<void>): Promise<void> {
  const outDir = buildProject();
  const h = await startUiServer({
    projectDir: outDir,
    port: 0,
    host: "127.0.0.1",
    hbc: FIXTURE_HBC,
    prewarm: false,
    noAuth: true,
    llmBackend: "fake",
  });
  try {
    await run(h);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
}

function url(h: UiServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`;
}

/** Spec 28 landing 4d (P-61 resolved): the three write actions now enqueue
 *  (`202 {jobId}`) instead of answering the surface's result directly --
 *  this polls the REAL background pool (`server.ts`'s `startWorkers`, which
 *  ticks every `WORKER_POLL_MS`) the same way the UI's own client
 *  (`ui/src/workers/readability-wire.ts`) does, over a real socket. */
async function pollJobDone(h: UiServerHandle, jobId: string, timeoutMs = 10_000): Promise<{ readonly status: string; readonly result?: unknown; readonly error?: string | null }> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(url(h, "/api/jobs"));
    const { rows } = (await res.json()) as { rows: readonly { readonly id: string; readonly status: string; readonly result?: unknown; readonly error?: string | null }[] };
    const job = rows.find((r) => r.id === jobId);
    if (job !== undefined && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not finish within ${String(timeoutMs)}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a real ui-server process with --llm-backend fake answers every readability route (200/202), not 503, and the real background pool runs the enqueued jobs", async () => {
  await withServer(async (h) => {
    const list = await fetch(url(h, "/api/readability/suggestions"));
    assert.equal(list.status, 200, "the landing 4c blocker: this used to 503 unconditionally");
    const listJson = (await list.json()) as { suggestions: readonly unknown[]; total: number; backend: string };
    assert.deepEqual(listJson.suggestions, []);
    assert.equal(listJson.backend, "fake");

    const suggest = await fetch(url(h, "/api/readability/actions/suggest-names"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn: 0 }),
    });
    // Spec 28 landing 4d (P-61 resolved): enqueued, not run inline.
    assert.equal(suggest.status, 202, "the four actions now enqueue rather than 503/200 directly");
    const { jobId: suggestJobId } = (await suggest.json()) as { jobId: string };
    const suggestJob = await pollJobDone(h, suggestJobId);
    assert.equal(suggestJob.status, "done", "the real background pool (startWorkers) must actually claim and run this job");
    const suggestResult = suggestJob.result as { suggestions: readonly unknown[]; equiv: { verdict: string } };
    assert.equal(suggestResult.equiv.verdict, "PASS");

    const review = await fetch(url(h, "/api/readability/actions/review"), { method: "POST" });
    assert.equal(review.status, 200, "review has nothing to enqueue and stays synchronous");
    const reviewJson = (await review.json()) as { opened: boolean; pending: number };
    assert.equal(reviewJson.opened, true);

    // rewrite-function: the FakeBackend's default reply names/parses nothing
    // useful as a rewrite proposal, so the job is expected to finish `done`
    // with `accepted: false` rather than fail -- the surface call itself
    // must not throw just because the model abstained.
    const rewrite = await fetch(url(h, "/api/readability/actions/rewrite-function"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fn: 0 }),
    });
    assert.equal(rewrite.status, 202);
    const { jobId: rewriteJobId } = (await rewrite.json()) as { jobId: string };
    const rewriteJob = await pollJobDone(h, rewriteJobId);
    assert.equal(rewriteJob.status, "done");
    assert.equal((rewriteJob.result as { accepted: boolean }).accepted, false);

    // combine-files: malformed args are a 400, still not a 503/500 -- proves
    // the route is live and doing its own validation, not just absent.
    const combineBad = await fetch(url(h, "/api/readability/actions/combine-files"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: ["only-one.js"], outputs: ["out.js"], evidence: "e" }),
    });
    assert.equal(combineBad.status, 400);

    // promote refuses a worker `who` (section 1d) BEFORE it even looks up
    // the id -- proves the real gate runs end to end over the socket, not
    // just in the pure-function suite (the FakeBackend's default reply is a
    // plain string, not the JSON envelope `suggest-names` parses, so it
    // abstains and there is no real suggestion id to promote here -- that
    // path is `readability-routes.test.ts`'s job).
    const promoteAsWorker = await fetch(url(h, "/api/readability/promote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestionId: "sid-does-not-exist", who: "worker:fake" }),
    });
    assert.equal(promoteAsWorker.status, 409, "a worker: promoter must be refused even over the live socket");

    // As a human, the same nonexistent id is a 400 (not found), never a
    // crash -- the route is live and doing real work either way.
    const promoteAsHuman = await fetch(url(h, "/api/readability/promote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestionId: "sid-does-not-exist", who: "fred" }),
    });
    assert.equal(promoteAsHuman.status, 400);
  });
});

test("a project with no split tree at <projectDir>/src still starts, readability routes 503", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-readability-notree-"));
  const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
  // Split tree written straight to `outDir`, NOT `outDir/src` -- the shape
  // `buildReadabilityCtx` must correctly treat as "no readable tree".
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  const h = await startUiServer({ projectDir: outDir, port: 0, host: "127.0.0.1", prewarm: false, noAuth: true, llmBackend: "fake" });
  try {
    const res = await fetch(url(h, "/api/readability/suggestions"));
    assert.equal(res.status, 503);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("an invalid --llm-backend id disables readability (503) rather than crashing the server", async () => {
  const outDir = buildProject();
  const h = await startUiServer({
    projectDir: outDir,
    port: 0,
    host: "127.0.0.1",
    hbc: FIXTURE_HBC,
    prewarm: false,
    noAuth: true,
    llmBackend: "not-a-real-backend",
  });
  try {
    const res = await fetch(url(h, "/api/readability/suggestions"));
    assert.equal(res.status, 503);
    // the ordinary API must still work -- an invalid readability backend id
    // never takes the whole server down.
    const modules = await fetch(url(h, "/api/modules"));
    assert.equal(modules.status, 200);
  } finally {
    await h.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});
