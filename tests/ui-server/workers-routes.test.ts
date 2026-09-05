// tests/ui-server/workers-routes.test.ts — docs/specs/23-ui-workers.md §6's
// HTTP contract, over the SAME rn-template fixture recipe
// `tests/ui-server/routes.test.ts` uses (copied deliberately: the worker
// routes must be exercised against a real project DB with real fn targets,
// not a synthetic one). Rung-owned properties only — no literal-string
// assertion against a shared fixture's decompiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import type { JobsResult, SuggestionsResult, WorkerEventsTail } from "../../src/ui-server/workers-routes.ts";
import { JobQueue, type EnqueueResult } from "../../src/workers/queue.ts";
import { Presence } from "../../src/workers/presence.ts";
import { WorkerRunner } from "../../src/workers/runner.ts";
import { HeuristicBackend, calleeNames, deriveName } from "../../src/workers/backends/heuristic.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const FN = 188;

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-workers-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

const outDir = buildFixture();
const db = openProjectDb(join(outDir, "project.hbcproj"));
test.after(() => {
  db.close();
  rmSync(outDir, { recursive: true, force: true });
});

const mcp = new McpContext(outDir, { hbc: RN_TEMPLATE });
const queue = new JobQueue(db);
const presence = new Presence(db);
const runner = new WorkerRunner({
  db,
  resources: mcp.resources,
  tools: mcp.tools,
  backend: new HeuristicBackend(),
  queue,
  presence,
  writeSuggestedNames: true,
});
const ctx: UiServerCtx = {
  resources: mcp.resources,
  tools: mcp.tools,
  artifactDir: outDir,
  workers: { db, queue, presence, runner, backendId: "heuristic", concurrency: 2 },
};
const ctxNoWorkers: UiServerCtx = { resources: mcp.resources, tools: mcp.tools, artifactDir: outDir };

function get(path: string, query: Record<string, string> = {}, c: UiServerCtx = ctx) {
  return handle({ method: "GET", path, query, body: undefined }, c);
}
function post(path: string, body: unknown, c: UiServerCtx = ctx) {
  return handle({ method: "POST", path, query: {}, body }, c);
}

// -- the backend itself (deterministic, no model) ----------------------------

test("HeuristicBackend derives a name from the function's own callees, deterministically", async () => {
  const source = "function f(a) { a.dispatchEvent(1); a.dispatchEvent(2); a.rare(3); return 'hello world'; }";
  assert.equal(calleeNames(source)[0], "dispatchEvent");
  assert.equal(deriveName("fn:188", source), "dispatchEventHandler");
  // No callee, no string -> still a valid identifier, never empty.
  assert.match(deriveName("fn:188", "return 1;"), /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  // Same input, same output — twice, on two instances.
  const a = await new HeuristicBackend().run({ kind: "suggest-name", prompt: "p", context: { target: "fn:1", source } });
  const b = await new HeuristicBackend().run({ kind: "suggest-name", prompt: "p", context: { target: "fn:1", source } });
  assert.equal(a.text, b.text);
});

test("HeuristicBackend explains structurally: params, callees, strings", async () => {
  const res = await new HeuristicBackend().run({
    kind: "explain-fn",
    prompt: "p",
    context: {
      target: "fn:188",
      summary: { fn: 188, name: "boot", module: 3, file: "index.js", lines: [1, 9], params: 2, kind: "function", edgesIn: 1, edgesOut: 4 },
      source: "function boot(a, b) { a.startApp('main'); }",
    },
  });
  assert.match(res.text, /fn:188/);
  assert.match(res.text, /2 parameters/);
  assert.match(res.text, /startApp/);
  assert.match(res.text, /"main"/);
});

// -- the routes --------------------------------------------------------------

test("the worker routes 503 when the server runs without workers", async () => {
  for (const path of ["/api/jobs", "/api/sessions", "/api/worker-events", "/api/suggestions"]) {
    assert.equal((await get(path, {}, ctxNoWorkers)).status, 503, path);
  }
});

test("POST /api/jobs validates kind and input", async () => {
  assert.equal((await post("/api/jobs", { kind: "not-a-kind", input: {} })).status, 400);
  assert.equal((await post("/api/jobs", { kind: "suggest-name", input: 7 })).status, 400);
  assert.equal((await get("/api/jobs", { status: "nope" })).status, 400);
});

// Regression: BUG 1, ui-qa-report.md — `createdBy: "ui"` (no such session)
// used to reach sqlite raw and 500 "FOREIGN KEY constraint failed"
// (jobs.created_by TEXT REFERENCES sessions(id)). It must now be a 400 with
// a reason naming the field, and a real session id or no field at all must
// still enqueue and reach `done`.
test("POST /api/jobs: an unknown createdBy is a 400, never a 500", async () => {
  const res = await post("/api/jobs", { kind: "suggest-name", input: { fn: FN }, createdBy: "ui" });
  assert.equal(res.status, 400);
  assert.match(String((res.json as { reason: string }).reason), /createdBy/);
  assert.match(String((res.json as { reason: string }).reason), /not a known session/);
});

test("POST /api/jobs: a live session id, or no createdBy, enqueues and runs to done", async () => {
  const session = presence.open({ kind: "human", who: "test-ui" });
  const withSession = await post("/api/jobs", { kind: "suggest-name", input: { fn: FN }, createdBy: session.id, idempotencyKey: "k-with-session" });
  assert.equal(withSession.status, 200);
  const enqWithSession = withSession.json as EnqueueResult;
  assert.equal(enqWithSession.job.createdBy, session.id);
  await runner.runUntilIdle();
  assert.equal(queue.get(enqWithSession.job.id)!.status, "done");

  const withoutCreatedBy = await post("/api/jobs", { kind: "suggest-name", input: { fn: FN }, idempotencyKey: "k-no-session" });
  assert.equal(withoutCreatedBy.status, 200);
  const enqNoSession = withoutCreatedBy.json as EnqueueResult;
  assert.equal(enqNoSession.job.createdBy, null);
  await runner.runUntilIdle();
  assert.equal(queue.get(enqNoSession.job.id)!.status, "done");
});

test("enqueue is idempotent and the jobs list carries target/elapsed/backend", async () => {
  const first = await post("/api/jobs", { kind: "explain-fn", input: { fn: FN } });
  assert.equal(first.status, 200);
  const enq = first.json as EnqueueResult;
  assert.equal(enq.deduped, false);
  assert.equal(enq.job.status, "queued");
  const again = (await post("/api/jobs", { kind: "explain-fn", input: { fn: FN } })).json as EnqueueResult;
  assert.equal(again.deduped, true);
  assert.equal(again.job.id, enq.job.id);

  const listed = (await get("/api/jobs")).json as JobsResult;
  assert.equal(listed.backend, "heuristic");
  assert.equal(listed.concurrency, 2);
  const row = listed.rows.find((r) => r.id === enq.job.id);
  assert.ok(row !== undefined);
  assert.equal(row.target, `fn:${FN}`);
  assert.equal(row.elapsedMs, null); // never started yet
});

test("enqueue -> runner tick -> suggestion visible -> promote -> acceptedName; and reject", async () => {
  const enq = (await post("/api/jobs", { kind: "suggest-name", input: { fn: FN } })).json as EnqueueResult;
  await runner.runUntilIdle();
  const done = (await get("/api/jobs", { status: "done" })).json as JobsResult;
  const job = done.rows.find((r) => r.id === enq.job.id);
  assert.ok(job !== undefined, "the suggest-name job finished");
  assert.ok((job.elapsedMs ?? -1) >= 0, "a finished job reports elapsed time");

  const suggestions = (await get("/api/suggestions", { fn: String(FN) })).json as SuggestionsResult;
  const nameRow = suggestions.rows.find((r) => r.kind === "name");
  const commentRow = suggestions.rows.find((r) => r.kind === "comment");
  assert.ok(nameRow !== undefined, "the proposed name is a promotable suggestion");
  assert.ok(commentRow !== undefined, "the [ai-suggested] comment is listed too");
  assert.equal(nameRow.who, "worker:suggest-name");
  assert.equal(nameRow.run, enq.job.id);
  assert.equal(nameRow.rejected, false);

  // Promotion is what makes it truth, under the PROMOTER's provenance.
  const promoted = await post("/api/suggestions/promote", {
    kind: "name",
    target: `fn:${FN}`,
    rid: nameRow.rid,
    prov: { source: "human", who: "analyst@duck.com" },
  });
  assert.equal(promoted.status, 200);
  const context = (await get(`/api/fn/${FN}/context`)).json as {
    readonly metadata?: { readonly acceptedName?: string | null };
    readonly source?: { readonly text: string };
  };
  assert.equal(context.metadata?.acceptedName, nameRow.text);
  // Promotion goes through the same `set_name` path a human rename does, so
  // it must RENDER too, not just be reported (the "rename doesn't work in the
  // UI" bug, tests/ui-server/fn-rename.test.ts): the accepted name is the
  // function's declared name in the served source.
  assert.match(context.source!.text, new RegExp(`function\\s+${nameRow.text}\\s*\\(`), "an accepted (promoted) name is the rendered declaration");

  // Reject writes nothing authoritative — it only notes the rid on the job.
  const rejected = await post("/api/suggestions/reject", { rid: commentRow.rid });
  assert.equal(rejected.status, 200);
  assert.deepEqual(rejected.json, { rid: commentRow.rid, rejected: true, recorded: true, wrote: false });
  const after = (await get("/api/suggestions", { fn: String(FN) })).json as SuggestionsResult;
  assert.equal(after.rows.find((r) => r.rid === commentRow.rid)?.rejected, true);
  // …and the comment is still there: a rejection is not a deletion (§4).
  assert.ok(after.rows.some((r) => r.rid === commentRow.rid));
});

test("promote refuses an rid that is not a live suggestion", async () => {
  const r = await post("/api/suggestions/promote", { kind: "name", target: `fn:${FN}`, rid: "999999" });
  assert.equal(r.status, 400);
  assert.match(String((r.json as { reason: string }).reason), /not a live suggestion/);
});

test("cancel: a queued job never runs, and 404s when unknown", async () => {
  const enq = (await post("/api/jobs", { kind: "explain-fn", input: { fn: 190 } })).json as EnqueueResult;
  const cancelled = await post(`/api/jobs/${enq.job.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.json as { job: { status: string } }).job.status, "cancelled");
  const ran = await runner.runUntilIdle();
  assert.ok(!ran.some((j) => j.id === enq.job.id), "a cancelled job is never claimed");
  assert.equal((await post("/api/jobs/nope/cancel", {})).status, 404);
});

test("GET /api/worker-events tails by cursor, like /api/log/tail", async () => {
  const first = (await get("/api/worker-events")).json as WorkerEventsTail;
  assert.ok(first.rows.length > 0, "running jobs left a change feed");
  assert.ok(first.rows.every((r, i, all) => i === 0 || r.seq > all[i - 1]!.seq), "oldest first, monotonic");
  assert.equal(first.cursor, first.rows[first.rows.length - 1]!.seq);
  const empty = (await get("/api/worker-events", { since: String(first.cursor) })).json as WorkerEventsTail;
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.cursor, first.cursor, "an empty tail returns the cursor it was given");
  assert.equal((await get("/api/worker-events", { since: "abc" })).status, 400);
});

test("sessions: open, heartbeat, and only live ones are listed", async () => {
  const opened = (await post("/api/sessions", { kind: "human", who: "analyst@duck.com" })).json as { id: string };
  const listed = (await get("/api/sessions")).json as { rows: readonly { who: string; kind: string }[] };
  assert.ok(listed.rows.some((s) => s.who === "analyst@duck.com" && s.kind === "human"));
  assert.equal((await post(`/api/sessions/${opened.id}/heartbeat`, {})).status, 200);
  assert.equal((await post("/api/sessions/no-such-session/heartbeat", {})).status, 404);
  assert.equal((await post("/api/sessions", { kind: "robot", who: "x" })).status, 400);
});
