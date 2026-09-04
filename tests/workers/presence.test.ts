// tests/workers/presence.test.ts — docs/specs/23-ui-workers.md §3 and §8:
// sessions, heartbeat TTL, advisory claims and their expiry, all on an
// INJECTED clock so nothing here sleeps or depends on wall time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openProjectDb } from "../../src/projdb/db.ts";
import { Presence } from "../../src/workers/presence.ts";
import { readWorkerEvents } from "../../src/workers/events.ts";

function fresh(ttlMs = 30_000): { db: ReturnType<typeof openProjectDb>; presence: Presence; tick: (ms: number) => void } {
  const db = openProjectDb(":memory:");
  let t = Date.parse("2026-09-04T10:00:00.000Z");
  const presence = new Presence(db, { now: () => t, ttlMs });
  return { db, presence, tick: (ms: number) => (t += ms) };
}

function types(db: ReturnType<typeof openProjectDb>): string[] {
  return readWorkerEvents(db, { limit: 1000 }).map((e) => e.type);
}

test("the three participant classes are peers in one table (§0)", () => {
  const { db, presence } = fresh();
  const human = presence.open({ kind: "human", who: "analyst@duck.com" });
  const worker = presence.open({ kind: "worker", who: "worker:explain-fn" });
  const external = presence.open({ kind: "external", who: "claude-desktop" });
  assert.deepEqual(
    presence.liveSessions().map((s) => s.kind).sort(),
    ["external", "human", "worker"],
  );
  assert.notEqual(human.id, worker.id);
  assert.notEqual(worker.id, external.id);
  assert.equal(types(db).filter((t) => t === "session.open").length, 3);
  db.close();
});

test("heartbeat keeps a session live past the TTL; without it, it ages out", () => {
  const { db, presence, tick } = fresh(30_000);
  const s = presence.open({ kind: "human", who: "analyst@duck.com" });
  tick(20_000);
  assert.equal(presence.heartbeat(s.id), true);
  tick(20_000);
  assert.equal(presence.liveSessions().length, 1); // 20s since the beat
  tick(20_000);
  assert.equal(presence.liveSessions().length, 0); // 40s since the beat
  db.close();
});

test("close releases the session's claims and refuses a later heartbeat", () => {
  const { db, presence } = fresh();
  const s = presence.open({ kind: "worker", who: "worker:explain-fn" });
  presence.claim("fn:188", s.id);
  presence.close(s.id);
  assert.equal(presence.claimOn("fn:188"), undefined);
  assert.equal(presence.heartbeat(s.id), false);
  assert.deepEqual(types(db), ["session.open", "claim.acquire", "claim.release", "session.close"]);
  db.close();
});

test("a claim is exclusive while live and reclaimable once expired (TTL)", () => {
  const { db, presence, tick } = fresh(30_000);
  const a = presence.open({ kind: "human", who: "analyst@duck.com" });
  const b = presence.open({ kind: "worker", who: "worker:suggest-name" });
  assert.ok(presence.claim("fn:188", a.id));
  assert.equal(presence.claimHolder("fn:188"), a.id);
  assert.equal(presence.claim("fn:188", b.id), undefined); // held by a
  assert.equal(presence.claim("fn:999", b.id)?.session, b.id); // a different target is free

  tick(31_000);
  // Expiry is computed on READ — no sweep has run yet.
  assert.equal(presence.claimHolder("fn:188"), undefined);
  assert.equal(presence.claim("fn:188", b.id)?.session, b.id);
  db.close();
});

test("expire() sweeps stale claims and sessions and emits the events", () => {
  const { db, presence, tick } = fresh(30_000);
  const s = presence.open({ kind: "worker", who: "worker:explain-fn" });
  presence.claim("fn:188", s.id);
  assert.deepEqual(presence.expire(), { claims: [], sessions: [] });

  tick(31_000);
  const reaped = presence.expire();
  assert.deepEqual(reaped.claims, ["fn:188"]);
  assert.deepEqual(reaped.sessions, [s.id]);
  assert.equal(presence.liveSessions().length, 0);
  assert.deepEqual(presence.expire(), { claims: [], sessions: [] }); // idempotent
  const t = types(db);
  assert.equal(t.filter((x) => x === "claim.release").length, 1);
  assert.equal(t.filter((x) => x === "session.close").length, 1);
  const closeEvent = readWorkerEvents(db, { limit: 1000 }).find((e) => e.type === "session.close");
  assert.equal(closeEvent?.detail?.["reason"], "ttl-expired");
  db.close();
});

test("release only works for the holder; re-claiming refreshes the TTL", () => {
  const { db, presence, tick } = fresh(30_000);
  const a = presence.open({ kind: "human", who: "analyst@duck.com" });
  const b = presence.open({ kind: "worker", who: "worker:explain-fn" });
  presence.claim("fn:188", a.id);
  assert.equal(presence.release("fn:188", b.id), false);
  tick(20_000);
  presence.claim("fn:188", a.id); // refresh
  tick(20_000);
  assert.equal(presence.claimHolder("fn:188"), a.id);
  assert.equal(presence.release("fn:188", a.id), true);
  assert.equal(presence.claimOn("fn:188"), undefined);
  db.close();
});

test("a closed session cannot claim", () => {
  const { db, presence } = fresh();
  const s = presence.open({ kind: "external", who: "claude-desktop" });
  presence.close(s.id);
  assert.equal(presence.claim("fn:188", s.id), undefined);
  db.close();
});
