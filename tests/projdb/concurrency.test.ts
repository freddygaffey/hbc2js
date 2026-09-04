// tests/projdb/concurrency.test.ts — docs/specs/18-project-storage-
// integrity.md §R3 metric 3 / §14 tests 6 & 8 / §R4 step 5 (SPEC 18's FINAL
// step): the concurrency proof. Two writers run on genuinely separate
// `worker_threads` native threads (tests/projdb/concurrency-worker.ts) —
// never sharing a DB (SQLite's single-writer lock is a non-issue by
// construction: each writer's `.hbcproj` is its own private `:memory:`
// instance) — and race real, simultaneous filesystem writes of ~1000
// findings' worth of per-finding shard files into ONE shared directory,
// including a batch of findings both writers submit IDENTICALLY (same
// target+evidence) to exercise content-hash dedup.
//
// Proves the three §R3 metric-3 properties directly on the shared
// directory's post-race state:
//   1. 0 id collisions — every distinct (target, evidence) tuple maps to a
//      distinct content-hash id (test 6 first half).
//   2. 0 lost writes — every attempted tuple (shared + each writer's own)
//      has a valid, correctly-contented shard file on disk afterwards
//      (test 8: "different files with no contention").
//   3. Dedup on identical findings — the tuples BOTH writers wrote
//      identically collapse to exactly ONE shard file, not two (test 6
//      second half).
// Additionally confirms each writer's OWN private export (shards + hash-
// chained log, written to its own directory, never raced) verifies clean —
// running concurrently with another writer doesn't corrupt a writer's own
// consistent view of its own state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findingContentId } from "../../src/projdb/export.ts";
import { rebuildProject } from "../../src/projdb/rebuild.ts";
import { verifyProject } from "../../src/projdb/verify.ts";
import { requireSweep } from "../support/tiers.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");
const WORKER_SCRIPT = fileURLToPath(new URL("./concurrency-worker.ts", import.meta.url));

interface Tuple {
  readonly target: string;
  readonly evidence: readonly { ref: string; role: string }[];
  readonly claim: string;
}

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `hbc2js-concurrency-${name}-`));
}

/** Deterministic tuple generation: `range` uses a target namespace disjoint
 *  from every other range, so two DISTINCT tuples never accidentally hash
 *  to the same id — any collision found in the assertions below is a real
 *  one, not a fixture artefact. */
function makeTuples(rangeBase: number, count: number, claimPrefix: string): Tuple[] {
  const out: Tuple[] = [];
  for (let i = 0; i < count; i++) {
    const n = rangeBase + i;
    out.push({ target: `fn:${n}`, evidence: [{ ref: `reg:${n}:0`, role: "source" }], claim: `${claimPrefix}-${i}` });
  }
  return out;
}

function runWorker(input: { writerId: string; ownDir: string; sharedAnalysisDir: string; tuples: readonly Tuple[] }): Promise<{ writerId: string; ownWritten: number; sharedWritten: number; sharedUnchanged: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SCRIPT, { workerData: input });
    let settled = false;
    worker.once("message", (msg) => {
      settled = true;
      resolve(msg as { writerId: string; ownWritten: number; sharedWritten: number; sharedUnchanged: number });
    });
    worker.once("error", (err) => {
      if (!settled) reject(err);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`concurrency worker exited with code ${code}`));
    });
  });
}

/** Runs the two-worker concurrency proof at a given scale and asserts the
 *  three §R3 metric-3 properties + "verify passes". `sharedCount` tuples are
 *  submitted IDENTICALLY by both writers (dedup); `distinctCount` tuples are
 *  private to each writer, in disjoint target ranges (no lost writes, no
 *  cross-writer id collisions). Total write calls across both workers:
 *  `sharedCount * 2 + distinctCount * 2`. Known cost note: `writeFindingShardForRid`
 *  (`src/projdb/export.ts`) re-scans ALL of a DB's finding records on every
 *  call (`DbRevisionStore.allRecords()`), making both this per-finding write
 *  loop and `exportProject`'s own bulk finding pass O(n^2) in finding count —
 *  see docs/BUGS.md ("writeFindingShardForRid re-scans all records per
 *  call") — which is why the default (gate) scale below is far under 1000
 *  and the true spec-scale (§R3 metric 3, 1000 findings) run is sweep-gated. */
async function runConcurrencyProof(sharedCount: number, distinctCount: number): Promise<void> {
  const shared = makeTuples(0, sharedCount, "shared-finding");
  const distinctA = makeTuples(10_000, distinctCount, "writerA-finding");
  const distinctB = makeTuples(20_000, distinctCount, "writerB-finding");

  const ownA = tmpDir("owna");
  const ownB = tmpDir("ownb");
  const sharedRoot = tmpDir("shared");
  const sharedAnalysisDir = join(sharedRoot, "analysis");

  try {
    const [resA, resB] = await Promise.all([
      runWorker({ writerId: "writerA", ownDir: ownA, sharedAnalysisDir, tuples: [...shared, ...distinctA] }),
      runWorker({ writerId: "writerB", ownDir: ownB, sharedAnalysisDir, tuples: [...shared, ...distinctB] }),
    ]);
    assert.equal(resA.writerId, "writerA");
    assert.equal(resB.writerId, "writerB");

    // --- Property 1: 0 id collisions among DISTINCT tuples ---------------
    const allDistinctTuples = [...shared, ...distinctA, ...distinctB];
    const idToTuples = new Map<string, Set<string>>();
    for (const t of allDistinctTuples) {
      const id = findingContentId(t.target, t.evidence);
      const key = `${t.target}|${JSON.stringify(t.evidence)}`;
      const set = idToTuples.get(id) ?? new Set<string>();
      set.add(key);
      idToTuples.set(id, set);
    }
    for (const [id, keys] of idToTuples) {
      assert.equal(keys.size, 1, `id collision: content-hash id ${id} was produced by ${keys.size} distinct (target,evidence) tuples: ${[...keys].join(" / ")}`);
    }
    // Total distinct ids must equal total distinct tuples submitted (60
    // shared + 440 + 440 = 940) — no accidental collisions AND no
    // accidental duplicate ids within one writer's own distinct range.
    assert.equal(idToTuples.size, shared.length + distinctA.length + distinctB.length);

    // --- Properties 2 & 3: 0 lost writes + correct dedup on the shared,
    // truly-raced directory --------------------------------------------
    const findingsDir = join(sharedAnalysisDir, "findings");
    const files = readdirSync(findingsDir).filter((f) => f.endsWith(".json"));
    // Exactly one file per distinct id: shared tuples (written by BOTH
    // workers, racing on the same path) collapse to one file each, not
    // two; every distinct tuple's file exists (nothing lost).
    assert.equal(files.length, idToTuples.size, `expected exactly one shard file per distinct finding (${idToTuples.size}), found ${files.length} — either a lost write or an unexpected duplicate`);

    for (const t of allDistinctTuples) {
      const id = findingContentId(t.target, t.evidence);
      const path = join(findingsDir, `${id}.json`);
      assert.ok(existsSync(path), `lost write: no shard file for target ${t.target} (expected ${path})`);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { target?: unknown; evidence?: unknown; id?: unknown };
      assert.equal(parsed.target, t.target, `corrupt/overwritten shard for id ${id}: target mismatch`);
      assert.equal(parsed.id, id, `shard file ${path} does not self-report id ${id}`);
      assert.deepEqual(parsed.evidence, t.evidence, `corrupt/overwritten shard for id ${id}: evidence mismatch`);
    }

    // --- Verify passes: each writer's OWN private export (never raced —
    // only the shared per-finding shard directory above was) is fully
    // self-consistent after running concurrently with the other. --------
    for (const [ownDir, expectedTuples] of [
      [ownA, [...shared, ...distinctA]] as const,
      [ownB, [...shared, ...distinctB]] as const,
    ]) {
      const rebuiltDb = new DatabaseSync(":memory:");
      rebuiltDb.exec(ddl);
      rebuildProject(rebuiltDb, ownDir);
      const result = verifyProject(rebuiltDb, ownDir);
      assert.ok(result.ok, `verify failed for ${ownDir}: ${JSON.stringify(result)}`);
      // Sanity: this writer's own export really did contain all its tuples.
      const ownFindingsDir = join(ownDir, "analysis", "findings");
      const ownFiles = existsSync(ownFindingsDir) ? readdirSync(ownFindingsDir).filter((f) => f.endsWith(".json")) : [];
      assert.equal(ownFiles.length, expectedTuples.length);
    }
  } finally {
    rmSync(ownA, { recursive: true, force: true });
    rmSync(ownB, { recursive: true, force: true });
    rmSync(sharedRoot, { recursive: true, force: true });
  }
}

test("concurrency: two real parallel writers, 0 id collisions, 0 lost writes, correct dedup, verify passes", async () => {
  // Gate scale: proves the same three properties as the full 1000-finding
  // run below at a size the ~120s local gate budget (docs/specs/18-project-
  // storage-integrity.md §R3 "Run cost") can absorb comfortably; see
  // runConcurrencyProof's doc comment for why (O(n^2) shard-write cost).
  await runConcurrencyProof(20, 80);
});

test("concurrency: two real parallel writers, 1000 findings (spec §R3 metric 3 scale)", async (t) => {
  if (!requireSweep(t)) return;
  // Matches §R3 metric 3 / §14 test 6 exactly: "two concurrent writers
  // record 1000 findings across overlapping modules" — 60 shared * 2 + 440
  // + 440 = 1000 write calls. Run directly:
  //   HBC2JS_TIER=sweep node --test tests/projdb/concurrency.test.ts
  await runConcurrencyProof(60, 440);
});
