// tests/projdb/log.test.ts — docs/specs/16-project-db.md §7 A3: history
// invariants for the annotation write verbs (`src/projdb/annotations.ts`,
// `src/projdb/revision-store.ts`). A batch of writes via the write-verb
// layer yields 1:1 `revisions`<->`log(op='annotate'|'revert')` rows in seq
// order; seq is gapless; a revert appends (never mutates, enforced by the
// schema's own triggers — `tests/projdb/schema.test.ts` A1b) and `v_active`
// reflects it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dbSetName, dbSetTag, dbRevertName, dbGetName } from "../../src/projdb/annotations.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

function humanProv(who = "fred") {
  return { source: "human" as const, who };
}

test("A3a every annotate write yields exactly one revisions row and one log row, same rid", () => {
  const db = freshDb();
  dbSetName(db, "fn:1", "decodePayload", humanProv(), { ts: "2026-09-03T00:00:01.000Z" });
  dbSetTag(db, "fn:1", "source", humanProv(), { ts: "2026-09-03T00:00:02.000Z" });
  dbSetName(db, "fn:1", "decodePayload2", humanProv(), { ts: "2026-09-03T00:00:03.000Z" });

  const revCount = (db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number }).n;
  const logAnnotate = (db.prepare(`SELECT COUNT(*) AS n FROM log WHERE op = 'annotate'`).get() as { n: number }).n;
  assert.equal(revCount, 3);
  assert.equal(logAnnotate, 3);

  const rows = db.prepare(`SELECT rid FROM revisions ORDER BY rid`).all() as { rid: number }[];
  for (const { rid } of rows) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM log WHERE rid = ?`).get(rid) as { n: number }).n;
    assert.equal(n, 1, `revisions.rid ${rid} must appear exactly once in log`);
  }
});

test("A3b log seq is gapless in write order", () => {
  const db = freshDb();
  dbSetName(db, "fn:1", "a", humanProv());
  dbSetName(db, "fn:2", "b", humanProv());
  dbSetTag(db, "fn:1", "reviewed", humanProv());
  const seqs = (db.prepare(`SELECT seq FROM log ORDER BY seq`).all() as { seq: number }[]).map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test("A3c revert appends a new revisions row (never mutates) and v_active reflects it", () => {
  const db = freshDb();
  const first = dbSetName(db, "fn:1", "alpha", humanProv(), { ts: "2026-09-03T00:00:01.000Z" });
  dbSetName(db, "fn:1", "beta", humanProv(), { ts: "2026-09-03T00:00:02.000Z" });
  assert.equal(dbGetName(db, "fn:1")?.value.name, "beta");

  const beforeRevertCount = (db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number }).n;
  const reverted = dbRevertName(db, "fn:1", humanProv());
  assert.equal(reverted?.value.name, "alpha");
  assert.equal(reverted?.rid, first.record.rid);

  const afterRevertCount = (db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number }).n;
  assert.equal(afterRevertCount, beforeRevertCount + 1, "revert must APPEND a row, not mutate an existing one");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM log WHERE op = 'revert'`).get() as { n: number }).n, 1);

  // v_active now resolves the slot back to `alpha`'s payload rid.
  assert.equal(dbGetName(db, "fn:1")?.value.name, "alpha");

  // The original two rows are byte-for-byte untouched (append-only triggers
  // would ABORT any UPDATE — this just confirms the read-back is stable).
  const firstRow = db.prepare(`SELECT ts FROM revisions WHERE rid = ?`).get(Number(first.record.rid)) as { ts: string };
  assert.equal(firstRow.ts, "2026-09-03T00:00:01.000Z");
});

test("A3d revert-to-empty clears the slot; a further revert is a true no-op (no new rows)", () => {
  const db = freshDb();
  dbSetName(db, "fn:9", "only", humanProv());
  const cleared = dbRevertName(db, "fn:9", humanProv());
  assert.equal(cleared, null);
  assert.equal(dbGetName(db, "fn:9"), undefined);

  const countAfterClear = (db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number }).n;
  const again = dbRevertName(db, "fn:9", humanProv());
  assert.equal(again, null);
  const countAfterNoop = (db.prepare(`SELECT COUNT(*) AS n FROM revisions`).get() as { n: number }).n;
  assert.equal(countAfterNoop, countAfterClear, "reverting an already-cleared slot must write nothing");
});
