// tests/workers/runner.test.ts — docs/specs/23-ui-workers.md §2/§4/§8, on a
// real `.hbcproj` built from the committed RN-template bundle. The gate's only
// backend is `FakeBackend`: deterministic, offline, no spawn. Asserts EFFECT
// (an annotation with the suggested marking + one log row per write, the
// promotion path, the cancellation write-guarantee) — never a literal compare
// against a shared construct fixture's decompiled text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { openProjectDb } from "../../src/projdb/db.ts";
import { McpTools } from "../../src/mcp/tools.ts";
import { McpResources } from "../../src/mcp/resources.ts";
import { JobQueue } from "../../src/workers/queue.ts";
import { Presence } from "../../src/workers/presence.ts";
import { FakeBackend } from "../../src/workers/backend.ts";
import { SUGGESTED_PREFIX, WorkerRunner, type JobResult } from "../../src/workers/runner.ts";
import { readWorkerEvents } from "../../src/workers/events.ts";
import { buildProject, projectDbPath, FN, RN_TEMPLATE } from "./support.ts";

const outDir = buildProject();
const db = openProjectDb(projectDbPath(outDir));
test.after(() => {
  db.close();
  rmSync(outDir, { recursive: true, force: true });
});

const tools = new McpTools(outDir, { hbc: RN_TEMPLATE });
const resources = new McpResources(outDir, { hbc: RN_TEMPLATE });
const target = `fn:${FN}`;

function makeRunner(backend: FakeBackend, presence?: Presence, sessionId?: string): WorkerRunner {
  return new WorkerRunner({
    db,
    resources,
    tools,
    backend,
    queue: new JobQueue(db),
    ...(presence !== undefined ? { presence } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

function logTotal(): number {
  return tools.project.log({}, { all: true }).total;
}

/** Comment bodies on a target with their provenance — read straight from the
 *  annotation stratum, so the test asserts what the STORE holds, not what a
 *  renderer chose to show. */
function comments(t: string): { body: string; who: string; source: string; run: string | null }[] {
  return db
    .prepare(
      `SELECT d.body AS body, r.prov_who AS who, r.prov_source AS source, r.prov_run AS run
         FROM revisions r JOIN d_comments d ON d.rid = r.rid WHERE r.target = ? ORDER BY r.rid`,
    )
    .all(t) as unknown as { body: string; who: string; source: string; run: string | null }[];
}

function activeName(t: string): string | undefined {
  const row = db
    .prepare(
      `SELECT d.name AS name FROM v_active a JOIN d_names d ON d.rid = a.payload_rid
        WHERE a.kind = 'name' AND a.target = ?`,
    )
    .get(t) as { name: string } | undefined;
  return row?.name;
}

test("explain-fn: the suggestion lands as an annotation marked suggested, with llm provenance and a log row", async () => {
  const backend = new FakeBackend();
  const runner = makeRunner(backend);
  const logBefore = logTotal();
  const before = comments(target).length;

  const { job } = runner.queue.enqueue({ kind: "explain-fn", input: { fn: FN } });
  const finished = await runner.runOne();

  assert.equal(finished?.id, job.id);
  assert.equal(finished?.status, "done");
  const rows = comments(target);
  assert.equal(rows.length, before + 1);
  const written = rows[rows.length - 1]!;
  assert.ok(written.body.startsWith(SUGGESTED_PREFIX), `body should carry the suggested marker: ${written.body}`);
  assert.ok(written.body.includes(job.id), "the annotation names the job that produced it");
  // §4: AI output is provenanced as llm, attributed to the worker, run = job id.
  assert.equal(written.source, "llm");
  assert.equal(written.who, "worker:explain-fn");
  assert.equal(written.run, job.id);
  // The write went through McpTools, so it logged exactly like any other write.
  assert.equal(logTotal(), logBefore + 1);
  const result = finished?.result as JobResult;
  assert.equal(result.tier, "suggested");
  assert.equal(result.writes.length, 1);
  assert.ok((finished?.cost?.tokensOut ?? 0) > 0);
  // The backend was handed the reads the runner made, never asked to fetch.
  assert.equal(backend.seen.length, 1);
  assert.ok(typeof backend.seen[0]!.context["source"] === "string");
});

test("suggest-name proposes only: the name slot is untouched until a human accepts", async () => {
  const runner = makeRunner(new FakeBackend());
  const nameBefore = activeName(target);
  const { job } = runner.queue.enqueue({ kind: "suggest-name", input: { fn: FN } });
  const finished = await runner.runOne();

  const result = finished?.result as JobResult;
  assert.equal(result.tier, "suggested");
  assert.equal(typeof result.proposal?.["name"], "string");
  // §4: nothing was written into the name slot by the worker.
  assert.equal(activeName(target), nameBefore);
  assert.ok(comments(target).some((c) => c.body.includes(`${SUGGESTED_PREFIX} name:`)));

  const logBefore = logTotal();
  const rid = runner.accept(job.id, { source: "human", who: "analyst@duck.com" });
  assert.ok(rid !== undefined);
  assert.equal(activeName(target), result.proposal?.["name"]);
  assert.equal(logTotal(), logBefore + 1);
  // The promotion carries the PROMOTER's provenance, not the worker's.
  const prov = db.prepare("SELECT prov_source AS s, prov_who AS w FROM revisions WHERE rid = ?").get(Number(rid)) as { s: string; w: string };
  assert.equal(prov.s, "human");
  assert.equal(prov.w, "analyst@duck.com");
  assert.equal((runner.queue.get(job.id)?.result as JobResult).tier, "accepted");
});

test("a job cancelled mid-flight writes nothing (§2.3)", async () => {
  const runner = makeRunner(
    new FakeBackend({
      replies: {
        "explain-fn": () => {
          // The human hits cancel while the backend is thinking.
          runner.queue.cancel(pending!.id);
          return "an explanation nobody asked for any more";
        },
      },
    }),
  );
  const pending = runner.queue.enqueue({ kind: "explain-fn", input: { fn: FN }, idempotencyKey: "cancel-me" }).job;
  const before = comments(target).length;
  const logBefore = logTotal();

  const finished = await runner.runOne();
  assert.equal(finished?.status, "cancelled");
  assert.equal(comments(target).length, before);
  assert.equal(logTotal(), logBefore);
  assert.equal(finished?.result, null);
});

test("idempotency: enqueuing the same work twice runs it once", async () => {
  const runner = makeRunner(new FakeBackend());
  const before = comments(target).length;
  const a = runner.queue.enqueue({ kind: "explain-fn", input: { fn: FN }, idempotencyKey: "dedup-run" });
  const b = runner.queue.enqueue({ kind: "explain-fn", input: { fn: FN }, idempotencyKey: "dedup-run" });
  assert.equal(b.deduped, true);
  assert.equal(a.job.id, b.job.id);
  const ran = await runner.runUntilIdle({ concurrency: 2 });
  assert.equal(ran.filter((j) => j.id === a.job.id).length, 1);
  assert.equal(comments(target).length, before + 1);
});

test("an unimplemented kind fails terminally instead of silently doing nothing", async () => {
  const runner = makeRunner(new FakeBackend());
  runner.queue.enqueue({ kind: "poc-finding", input: { findingRid: "1" } });
  const finished = await runner.runOne();
  assert.equal(finished?.status, "failed");
  assert.match(finished?.error ?? "", /not implemented/);
});

test("a transient backend failure requeues; a terminal one does not", async () => {
  const transient = makeRunner(new FakeBackend({ failKinds: { "explain-fn": { message: "spawn failed", transient: true } } }));
  const job = transient.queue.enqueue({ kind: "explain-fn", input: { fn: FN }, idempotencyKey: "flaky" }).job;
  const after = await transient.runOne();
  assert.equal(after?.status, "queued");
  assert.equal(after?.attempts, 1);
  // A working backend then picks the very same job up and completes it.
  const good = makeRunner(new FakeBackend());
  const done = await good.runOne();
  assert.equal(done?.id, job.id);
  assert.equal(done?.status, "done");
});

test("the runner claims its target while it works and releases it after", async () => {
  const presence = new Presence(db);
  const session = presence.open({ kind: "worker", who: "worker:explain-fn" });
  const runner = makeRunner(new FakeBackend(), presence, session.id);
  runner.queue.enqueue({ kind: "explain-fn", input: { fn: FN }, idempotencyKey: "claiming" });
  const seqBefore = readWorkerEvents(db, { limit: 100_000 }).length;
  await runner.runOne();
  assert.equal(presence.claimOn(target), undefined, "the claim is released when the job ends");
  const after = readWorkerEvents(db, { limit: 100_000 }).slice(seqBefore).map((e) => e.type);
  assert.deepEqual(after, ["job.started", "claim.acquire", "job.done", "claim.release"]);
  presence.close(session.id);
});
