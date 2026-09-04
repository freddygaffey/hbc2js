// tests/workers/queue.test.ts — docs/specs/23-ui-workers.md §2.2–§2.4 and
// §8: the job queue's state machine, idempotency and event feed, on an
// in-memory project DB (no bundle needed — the queue never reads the
// artifact). Rung-owned assertions only: statuses, counts, event types.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openProjectDb } from "../../src/projdb/db.ts";
import { JobQueue, MAX_ATTEMPTS, defaultIdempotencyKey } from "../../src/workers/queue.ts";
import { readWorkerEvents } from "../../src/workers/events.ts";

function freshQueue(): { db: ReturnType<typeof openProjectDb>; queue: JobQueue; tick: (ms: number) => void } {
  const db = openProjectDb(":memory:");
  let t = Date.parse("2026-09-04T10:00:00.000Z");
  const queue = new JobQueue(db, { now: () => t });
  return { db, queue, tick: (ms: number) => (t += ms) };
}

function types(db: ReturnType<typeof openProjectDb>): string[] {
  return readWorkerEvents(db, { limit: 1000 }).map((e) => e.type);
}

test("enqueue writes a queued job and one job.queued event", () => {
  const { db, queue } = freshQueue();
  const { job, deduped } = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } });
  assert.equal(deduped, false);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 0);
  assert.equal(job.idempotencyKey, defaultIdempotencyKey("explain-fn", { fn: 188 }));
  assert.deepEqual(types(db), ["job.queued"]);
  db.close();
});

test("the same idempotency key dedups: one row, one event, same id", () => {
  const { db, queue } = freshQueue();
  const first = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } });
  const second = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } });
  assert.equal(second.deduped, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal(queue.list().length, 1);
  assert.equal(types(db).filter((t) => t === "job.queued").length, 1);
  // A caller who wants a genuine re-run passes its own key (§1).
  const third = queue.enqueue({ kind: "explain-fn", input: { fn: 188 }, idempotencyKey: "rerun-1" });
  assert.equal(third.deduped, false);
  assert.equal(queue.list().length, 2);
  db.close();
});

test("claimNext is FIFO, marks running, and never hands the same job out twice", () => {
  const { db, queue, tick } = freshQueue();
  const a = queue.enqueue({ kind: "explain-fn", input: { fn: 1 } }).job;
  tick(1000);
  const b = queue.enqueue({ kind: "explain-fn", input: { fn: 2 } }).job;
  const first = queue.claimNext();
  assert.equal(first?.id, a.id);
  assert.equal(first?.status, "running");
  assert.equal(first?.attempts, 1);
  const second = queue.claimNext();
  assert.equal(second?.id, b.id);
  assert.equal(queue.claimNext(), undefined);
  db.close();
});

test("progress + finish record counters, result, cost and the events", () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 }, cost: { maxTokens: 500 } }).job;
  queue.claimNext();
  queue.progress(job.id, 1, 3);
  const finished = queue.finish(job.id, { result: { tier: "suggested" }, cost: { tokensIn: 10, tokensOut: 20 } });
  assert.equal(finished?.status, "done");
  assert.equal(finished?.progressDone, 1);
  assert.equal(finished?.progressTotal, 3);
  assert.deepEqual(finished?.result, { tier: "suggested" });
  // the enqueue-time LIMIT survives alongside what the run spent (§1)
  assert.equal(finished?.cost?.maxTokens, 500);
  assert.equal(finished?.cost?.tokensOut, 20);
  assert.deepEqual(types(db), ["job.queued", "job.started", "job.progress", "job.done"]);
  db.close();
});

test("cancel: a queued job never starts", () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } }).job;
  assert.equal(queue.cancel(job.id), true);
  assert.equal(queue.get(job.id)?.status, "cancelled");
  assert.equal(queue.claimNext(), undefined);
  assert.equal(queue.cancel(job.id), false); // already terminal
  assert.deepEqual(types(db), ["job.queued", "job.cancelled"]);
  db.close();
});

test("cancel: a running job can no longer be finished (§2.3)", () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } }).job;
  queue.claimNext();
  assert.equal(queue.cancel(job.id), true);
  const after = queue.finish(job.id, { result: { tier: "suggested" } });
  assert.equal(after?.status, "cancelled");
  assert.equal(after?.result, null);
  db.close();
});

test("fail: transient requeues up to MAX_ATTEMPTS, terminal never retries", () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } }).job;
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    queue.claimNext();
    const after = queue.fail(job.id, "spawn failed", { transient: true });
    assert.equal(after?.status, "queued", `attempt ${i} should requeue`);
    assert.equal(after?.attempts, i);
  }
  queue.claimNext();
  const exhausted = queue.fail(job.id, "spawn failed", { transient: true });
  assert.equal(exhausted?.status, "failed");
  assert.equal(exhausted?.attempts, MAX_ATTEMPTS);

  const other = queue.enqueue({ kind: "explain-fn", input: { fn: 2 } }).job;
  queue.claimNext();
  assert.equal(queue.fail(other.id, "unknown fn")?.status, "failed");
  db.close();
});

test("worker_events is append-only, like log and revisions", () => {
  const { db, queue } = freshQueue();
  queue.enqueue({ kind: "explain-fn", input: { fn: 188 } });
  assert.throws(() => db.exec("UPDATE worker_events SET type = 'job.done'"), /E_APPEND_ONLY: worker_events/);
  assert.throws(() => db.exec("DELETE FROM worker_events"), /E_APPEND_ONLY: worker_events/);
  db.close();
});

test("readWorkerEvents tails from a sequence number", () => {
  const { db, queue } = freshQueue();
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 } }).job;
  const firstSeq = readWorkerEvents(db)[0]!.seq;
  queue.claimNext();
  queue.finish(job.id, { result: { tier: "suggested" } });
  const tail = readWorkerEvents(db, { since: firstSeq });
  assert.deepEqual(
    tail.map((e) => e.type),
    ["job.started", "job.done"],
  );
  assert.ok(tail.every((e) => e.job === job.id));
  db.close();
});
