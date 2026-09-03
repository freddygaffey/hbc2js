// tests/projdb/revision-equiv.test.ts — docs/specs/16-project-db.md §7 A4:
// the DB-backed engine (`src/projdb/revision-store.ts`) is `RevisionStore`'s
// (`src/project/revision-store.ts`) semantics with the mutable `active` flag
// replaced by a `v_active` derivation, not a re-interpretation (§2.3). This
// replays ONE scripted write/supersede/revert/clear sequence against BOTH
// engines and asserts identical active-slot outcomes at every step and
// identical per-slot value timelines at the end.
//
// The two engines' bookkeeping differs by construction (RevisionStore flips
// an in-place `active` flag and mints no row on revert; the DB engine is
// append-only and always mints a fresh `revisions` row, even for a revert —
// §2.3's whole point). So this compares what a caller actually observes —
// `get(target)?.value` and the content-bearing `history(target)` value
// sequence — not internal bookkeeping shape (`rid` encoding, row counts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { RevisionStore } from "../../src/project/revision-store.ts";
import { dbAddComment, dbGetComment, dbRevertComment, dbCommentHistory } from "../../src/projdb/annotations.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

function prov() {
  return { source: "human" as const, who: "fred" };
}

interface Step {
  readonly op: "set" | "revert";
  readonly target: string;
  readonly value?: string;
  readonly ts: string;
}

const TARGETS = ["fn:1", "fn:2"];

// A script exercising: fresh set, same-slot supersede, revert-to-prior,
// supersede-after-reactivate, revert-to-empty (clear), no-op revert on an
// already-cleared slot, and a fresh set reusing a cleared slot.
const SCRIPT: readonly Step[] = [
  { op: "set", target: "fn:1", value: "A", ts: "2026-09-03T00:00:01.000Z" },
  { op: "set", target: "fn:2", value: "X", ts: "2026-09-03T00:00:02.000Z" },
  { op: "set", target: "fn:1", value: "B", ts: "2026-09-03T00:00:03.000Z" },
  { op: "revert", target: "fn:1", ts: "2026-09-03T00:00:04.000Z" }, // -> A
  { op: "set", target: "fn:1", value: "C", ts: "2026-09-03T00:00:05.000Z" }, // supersedes reactivated A
  { op: "revert", target: "fn:2", ts: "2026-09-03T00:00:06.000Z" }, // -> clear (only one record)
  { op: "revert", target: "fn:2", ts: "2026-09-03T00:00:07.000Z" }, // no-op, already clear
  { op: "set", target: "fn:2", value: "Y", ts: "2026-09-03T00:00:08.000Z" }, // fresh after clear
];

test("A4 DB engine and RevisionStore agree at every step of a scripted sequence", () => {
  const mem = new RevisionStore<{ body: string }>();
  const db = freshDb();

  SCRIPT.forEach((step, i) => {
    if (step.op === "set") {
      mem.set(step.target, { body: step.value! }, step.ts);
      dbAddComment(db, step.target, step.value!, prov(), { ts: step.ts });
    } else {
      mem.revert(step.target, undefined);
      dbRevertComment(db, step.target, prov());
    }

    for (const target of TARGETS) {
      const memActive = mem.get(target)?.value.body;
      const dbActive = dbGetComment(db, target)?.value.body;
      assert.equal(dbActive, memActive, `step ${i} (${step.op} ${step.target}): active value for ${target} diverged`);
    }
  });

  // Full per-slot value timelines (newest first) must match too — the
  // "identical timelines at every step" half of A4.
  for (const target of TARGETS) {
    const memTimeline = mem.history(target).map((r) => r.value.body);
    const dbTimeline = dbCommentHistory(db, target).map((r) => r.value.body);
    assert.deepEqual(dbTimeline, memTimeline, `history(${target}) diverged`);

    // The `active` flag must land on exactly the same value in both chains
    // (their `rid`/row encodings differ by construction — see module header).
    const memActiveValues = mem.history(target).filter((r) => r.active).map((r) => r.value.body);
    const dbActiveValues = dbCommentHistory(db, target).filter((r) => r.active).map((r) => r.value.body);
    assert.deepEqual(dbActiveValues, memActiveValues, `active flag placement for ${target} diverged`);
  }
});

test("A4 revert return value matches RevisionStore's for both reactivate and clear", () => {
  const mem = new RevisionStore<{ body: string }>();
  const db = freshDb();

  mem.set("fn:9", { body: "only" }, "2026-09-03T00:00:01.000Z");
  dbAddComment(db, "fn:9", "only", prov(), { ts: "2026-09-03T00:00:01.000Z" });

  const memCleared = mem.revert("fn:9");
  const dbCleared = dbRevertComment(db, "fn:9", prov());
  assert.equal(memCleared, null);
  assert.equal(dbCleared, null);

  mem.set("fn:9", { body: "again" }, "2026-09-03T00:00:02.000Z");
  dbAddComment(db, "fn:9", "again", prov(), { ts: "2026-09-03T00:00:02.000Z" });
  mem.set("fn:9", { body: "third" }, "2026-09-03T00:00:03.000Z");
  dbAddComment(db, "fn:9", "third", prov(), { ts: "2026-09-03T00:00:03.000Z" });

  const memReverted = mem.revert("fn:9");
  const dbReverted = dbRevertComment(db, "fn:9", prov());
  assert.equal(memReverted?.value.body, "again");
  assert.equal(dbReverted?.value.body, "again");
});
