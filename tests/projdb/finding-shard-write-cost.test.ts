// tests/projdb/finding-shard-write-cost.test.ts — regression test for
// docs/BUGS.md ("writeFindingShardForRid re-scans all records per call",
// 2026-09-04, spec 18 step 5). `writeFindingShardForRid`
// (`src/projdb/export.ts`) used to re-derive its target record by scanning
// EVERY finding revision (`new DbRevisionStore(db, findingAdapter)
// .allRecords()`) on every call, regardless of whether the caller already
// had the record in hand — making a full-project export O(n^2) in finding
// count (`exportProject`'s bulk finding loop calls this once per active
// record). The fix lets a caller pass the record it already has; this test
// proves the call then does O(1) SQL work (no scan at all) instead of O(n),
// using a synthetic DB with no real bundles — a wall-clock budget assertion
// would itself be the kind of flaky-on-CI-hardware test the BUGS row (and
// CLAUDE.md's testing rules) warn against, so this counts `db.prepare`
// calls instead of timing anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetFinding } from "../../src/projdb/annotations.ts";
import { exportProject, stateBindingOf, writeFindingShardForRid } from "../../src/projdb/export.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

function tmpProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "hbc2js-finding-shard-cost-"));
}

/** Counts calls to `db.prepare` made strictly inside `fn`, without
 *  disturbing `db`'s own behaviour (the wrapped function still delegates to
 *  the real `prepare`). */
function countPrepares(db: DatabaseSync, fn: () => void): number {
  const real = db.prepare.bind(db);
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (...args: unknown[]) => {
    count++;
    return (real as (...a: unknown[]) => unknown)(...args);
  };
  try {
    fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = real;
  }
  return count;
}

/** Seeds `count` distinct findings (disjoint targets, so every one is its
 *  own live slot) and returns the `DbRevision` for the LAST one written —
 *  i.e. a record a bulk caller iterating `allRecords()` would already have
 *  in hand for the final iteration, the worst case for the old O(n^2)
 *  behaviour (the fresh-scan cost is paid at the full DB size every time). */
function seedFindings(db: DatabaseSync, count: number) {
  let last;
  for (let i = 0; i < count; i++) {
    const r = dbSetFinding(
      db,
      `fn:${i}`,
      { findingNo: i, severity: "medium", status: "open", claim: `claim-${i}`, evidence: [{ ref: `reg:${i}:0`, role: "source" }] },
      { source: "tool", who: "cost-test" },
      { ts: `2026-09-04T00:00:00.${String(i).padStart(3, "0")}Z` },
    );
    last = r.record;
  }
  if (last === undefined) throw new Error("seedFindings: count must be > 0");
  return last;
}

test("writeFindingShardForRid: passing the record in hand does O(1) SQL work, not O(n) in finding count", () => {
  const N = 200;
  const db = freshDb();
  const target = seedFindings(db, N);
  const rid = Number(target.rid);
  const binding = stateBindingOf(db);
  const dir = tmpProjectDir();
  try {
    const resultWithRecord = { written: [] as string[], unchanged: [] as string[] };
    let withRecordOut: ReturnType<typeof writeFindingShardForRid> = null;
    const withRecordPrepares = countPrepares(db, () => {
      withRecordOut = writeFindingShardForRid(db, dir, binding, rid, resultWithRecord, target);
    });

    const resultNoRecord = { written: [] as string[], unchanged: [] as string[] };
    let noRecordOut: ReturnType<typeof writeFindingShardForRid> = null;
    const noRecordPrepares = countPrepares(db, () => {
      noRecordOut = writeFindingShardForRid(db, dir, binding, rid, resultNoRecord);
    });

    // Correctness: same target record found either way.
    assert.deepEqual(withRecordOut, noRecordOut);
    assert.notEqual(withRecordOut, null);

    // The whole point of the fix: passing the record in hand must cost a
    // small constant number of statements (nowhere near N), while the
    // no-record fallback still legitimately scans everything (O(n),
    // unchanged behaviour for a caller that has no record to hand) and so
    // costs at least N statements at this DB size. This is exactly the
    // property that was false before the fix, when the `record` parameter
    // did not exist and every call — regardless of what a caller had in
    // hand — cost O(n).
    assert.ok(withRecordPrepares < 10, `expected passing the record in hand to cost a small constant number of db.prepare calls, got ${withRecordPrepares}`);
    assert.ok(noRecordPrepares >= N, `expected the no-record fallback to still scan all ${N} records (>= ${N} db.prepare calls), got ${noRecordPrepares}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFindingShardForRid: exportProject's bulk finding pass does not re-scan per active record", () => {
  const N = 150;
  const db = freshDb();
  seedFindings(db, N);
  const dir = tmpProjectDir();
  try {
    // exportProject's own bulk finding loop iterates `allRecords()` once
    // (the correct O(n) shape) and, per the fix, must not additionally
    // scan `allRecords()` again inside `writeFindingShardForRid` for each
    // of the N active records it visits. `db.prepare` still runs plenty of
    // statements (the single allRecords() scan itself, plus one shard
    // write's worth of work per record) — the regression this guards is
    // specifically the SECOND full scan per record, which would push the
    // total prepare count well past N^2-shaped territory. A generous
    // bound (10*N) comfortably separates "O(n)" from "O(n^2) at N=150"
    // (22500) without coupling the test to the exact per-record constant.
    const prepares = countPrepares(db, () => {
      exportProject(db, dir);
    });
    assert.ok(prepares < 10 * N, `expected exportProject's finding pass to cost O(n) db.prepare calls (< ${10 * N} for N=${N}), got ${prepares} — looks O(n^2) again`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
