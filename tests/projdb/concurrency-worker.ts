// tests/projdb/concurrency-worker.ts — one "writer" for
// tests/projdb/concurrency.test.ts (docs/specs/18-project-storage-
// integrity.md §R3 metric 3 / §R4 step 5). Runs on its OWN `worker_threads`
// native thread with its OWN private `:memory:` `.hbcproj` DB — never
// shared with the other writer, so SQLite's single-writer lock never even
// comes into play (the DB is per-writer/operational; the design's
// contention-free claim is about the exported JSON shards, not the DB
// file). Two things happen, both proving a different half of §R3 metric 3 /
// test 6 / test 8:
//
//  1. A full `exportProject` into this writer's OWN private directory
//     (`ownDir`) — proves a single writer's own state stays internally
//     consistent (shards + hash-chained log) even while running truly
//     concurrently with another writer elsewhere. The `log/` journal is a
//     per-writer provenance trail (§5) — reconciled across writers via git
//     in the real workflow, same as any other file — so it is deliberately
//     NOT also written to the shared directory here: that would race two
//     independent from-genesis log rewrites against ONE file, which is a
//     real (out-of-scope) hazard the design never claims to cover. What
//     the design DOES claim contention-free is the per-finding shard files
//     (test 8), which step 2 below exercises directly.
//  2. A raw per-finding shard write (`writeFindingShardForRid`, no `log/`
//     involved) for EVERY finding straight into a SHARED directory
//     (`sharedAnalysisDir`) that the other writer's worker targets AT THE
//     SAME TIME — the literal concurrent-filesystem-write stress test of
//     "different modules/findings write different files with no
//     contention", including identical (shared) findings from both writers
//     racing to write the exact SAME path.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dbSetFinding } from "../../src/projdb/annotations.ts";
import type { DbRevision } from "../../src/projdb/revision-store.ts";
import type { FindingValue } from "../../src/projdb/annotations.ts";
import { exportProject, stateBindingOf, writeFindingShardForRid } from "../../src/projdb/export.ts";

interface Tuple {
  readonly target: string;
  readonly evidence: readonly { ref: string; role: string }[];
  readonly claim: string;
}

interface WorkerInput {
  readonly writerId: string;
  readonly ownDir: string;
  readonly sharedAnalysisDir: string;
  readonly tuples: readonly Tuple[];
}

const { writerId, ownDir, sharedAnalysisDir, tuples } = workerData as WorkerInput;

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
db.exec(ddl);

// Keeps the freshly-minted record alongside its rid — `dbSetFinding`
// already hands it back, so step 2 below can pass it straight into
// `writeFindingShardForRid` instead of making that function re-scan every
// finding revision in the DB per call (docs/BUGS.md
// "writeFindingShardForRid re-scans all records per call").
const records: DbRevision<FindingValue>[] = [];
let i = 0;
for (const t of tuples) {
  const r = dbSetFinding(
    db,
    t.target,
    { findingNo: i, severity: "medium", status: "open", claim: t.claim, evidence: t.evidence },
    { source: "tool", who: writerId },
    { ts: `2026-09-04T00:00:00.${String(i).padStart(3, "0")}Z` },
  );
  records.push(r.record);
  i++;
}

// Step 1: own private full export (shards + chained log) — never races.
const ownResult = exportProject(db, ownDir);

// Step 2: raw per-finding shard writes straight into the SHARED directory,
// concurrently with the other writer's worker doing the same — the actual
// contention-free-shard-files claim under test.
const binding = stateBindingOf(db);
const sharedResult = { written: [] as string[], unchanged: [] as string[] };
for (const r of records) writeFindingShardForRid(db, sharedAnalysisDir, binding, Number(r.rid), sharedResult, r);

parentPort?.postMessage({
  writerId,
  ownWritten: ownResult.written.length,
  sharedWritten: sharedResult.written.length,
  sharedUnchanged: sharedResult.unchanged.length,
});
