// tests/projdb/readability-shards.test.ts -- spec 18 sections 6/8/R3 applied
// to the new `analysis/readability/<id>.json` shard family
// (docs/specs/28-llm-readability.md section 9.5): export, rebuild and verify
// round-trip it exactly like names/annotations/findings, and nothing about
// the shard hash, the state binding or the log chain is special-cased.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetName } from "../../src/projdb/annotations.ts";
import { exportProject } from "../../src/projdb/export.ts";
import { rebuildProject } from "../../src/projdb/rebuild.ts";
import { verifyProject } from "../../src/projdb/verify.ts";
import { migrationSql } from "../../src/projdb/db.ts";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { repoRoot } from "../support/paths.ts";
import type { ReadabilityWorkerInput, ReadabilityWorkerMessage } from "../../src/workers/readability-worker.ts";
import { recordTransaction, sha256, transactionId } from "../../src/readability/transactions.ts";
import type { EquivProof, ReadabilityTransaction } from "../../src/readability/types.ts";

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

const proof: EquivProof = {
  scope: "tree",
  verdict: "PASS",
  oracle: "hbc2js equiv --hbc fixture.hbc tree/",
  coverage: { inputs: 4, records: 19 },
  ts: "2026-09-11T00:00:00Z",
};

function tx(n: number, content: string): ReadabilityTransaction {
  const inputs = [{ module: n }];
  const outputs = [{ path: `src/mod_${String(n)}.js`, origins: inputs }];
  return {
    id: transactionId("rename", inputs, outputs, `evidence ${String(n)}`),
    op: "rename",
    who: "worker:haiku",
    tier: "suggested",
    ts: `2026-09-11T00:00:0${String(n)}Z`,
    inputs,
    outputs,
    equiv: proof,
    evidence: `evidence ${String(n)}`,
    prior: { files: [{ path: `src/module_${String(n)}.js`, sha256: sha256(content) }] },
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

test("spec 28 section 9.5 + spec 18 section R3: readability shards export, rebuild and re-export byte-identically", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-readability-shards-"));
  const db = freshDb();
  try {
    // A normal annotation write alongside, so the readability tail is proved
    // to chain onto a real log, not an empty one.
    dbSetName(db, "fn:3:reg:4", "loopCounter", { source: "human", who: "fred" });
    for (const n of [1, 2]) {
      const content = `// module ${String(n)}\n`;
      recordTransaction(db, dir, tx(n, content), { priorContents: new Map([[`src/module_${String(n)}.js`, content]]) });
    }
    const shards = walk(join(dir, "analysis", "readability"));
    assert.equal(shards.length, 2);

    // Rebuild a fresh DB from the JSON side alone and re-export it.
    const rebuiltDir = mkdtempSync(join(tmpdir(), "hbc2js-readability-rebuilt-"));
    const rebuilt = freshDb();
    try {
      rebuildProject(rebuilt, dir);
      exportProject(rebuilt, rebuiltDir);
      for (const p of walk(join(dir, "analysis")).concat(walk(join(dir, "log")))) {
        const mirrored = p.replace(dir, rebuiltDir);
        assert.ok(existsSync(mirrored), `${p} missing after rebuild+export`);
        assert.equal(readFileSync(mirrored, "utf8"), readFileSync(p, "utf8"), `${p} is not byte-identical after rebuild+export`);
      }
    } finally {
      rebuilt.close();
      rmSync(rebuiltDir, { recursive: true, force: true });
    }

    const v = verifyProject(db, dir, { full: true });
    assert.equal(v.ok, true, v.full?.detail.join("; "));
    assert.equal(v.full?.readability.checked, 2);
    assert.deepEqual(v.full?.readability.problems, []);
    assert.ok(v.shards.some((s) => s.path.includes(join("analysis", "readability"))), "verify must walk the readability family too");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec 18 section 8: a hand-edited readability shard is caught by the hash lock, not mistaken for lag", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-readability-handedit-"));
  const db = freshDb();
  try {
    const content = "// module 1\n";
    const t = tx(1, content);
    recordTransaction(db, dir, t, { priorContents: new Map([["src/module_1.js", content]]) });
    const shardPath = join(dir, "analysis", "readability", `${t.id}.json`);
    const parsed = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    parsed.evidence = "a human edited this claim without re-locking the hash";
    writeFileSync(shardPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const v = verifyProject(db, dir);
    assert.equal(v.ok, false);
    assert.ok(v.shards.some((s) => s.path === shardPath && s.status === "hand-edit"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec 18 section 1.1: schema minor 6 is additive and its migration block is idempotent", () => {
  const sql = migrationSql(6);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS readability_tx/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS readability_blob/);
  assert.ok(!/\bALTER TABLE\b/.test(sql), "a minor bump may only create new objects");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(ddl);
    db.exec(sql);
    db.exec(sql);
    const row = db.prepare("SELECT count(*) AS n FROM readability_tx").get() as { n: number };
    assert.equal(row.n, 0);
  } finally {
    db.close();
  }
});

// docs/BUGS.md 2026-09-11 "readability jobs block the ui-server event loop"
// (docs/DECISIONS.md D34): `readability-suggest-names` now runs in
// `src/workers/readability-worker.ts`, a SECOND thread, over a project
// directory the main thread is the single writer of. Spec 18 sections 5-6's
// log is hash-chained, so a second writing connection could fork the chain;
// the worker therefore opens no project connection at all and writes only
// the P-59 name-overlay sidecar. This test runs the REAL worker against a
// REAL exported project and then demands `verify --full` still be clean --
// the shard hashes, the log chain and the readability family all intact,
// and the sidecar not mistaken for a shard.
const WORKER_SCRIPT = fileURLToPath(new URL("../../src/workers/readability-worker.ts", import.meta.url));
const SMALL_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");

function runWorker(input: ReadabilityWorkerInput): Promise<ReadabilityWorkerMessage> {
  return new Promise<ReadabilityWorkerMessage>((resolve, reject) => {
    const w = new Worker(WORKER_SCRIPT, { workerData: input });
    w.once("message", (m: ReadabilityWorkerMessage) => {
      void w.terminate();
      resolve(m);
    });
    w.once("error", reject);
  });
}

test("spec 18 sections 5-6: the off-thread readability worker leaves `hbcproj verify --full` clean (it is never a second writer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-readability-offthread-"));
  const db = freshDb();
  try {
    dbSetName(db, "fn:3:reg:4", "loopCounter", { source: "human", who: "fred" });
    for (const n of [1, 2]) {
      const content = `// module ${String(n)}\n`;
      recordTransaction(db, dir, tx(n, content), { priorContents: new Map([[`src/module_${String(n)}.js`, content]]) });
    }
    const before = verifyProject(db, dir, { full: true });
    assert.equal(before.ok, true, before.full?.detail.join("; "));

    const msg = await runWorker({ hbcPath: SMALL_HBC, projectDir: dir, treeDir: join(dir, "src"), backendId: "heuristic", surface: "ui", args: { target: { module: 0 } } });
    assert.equal(msg.ok, true, `worker failed: ${msg.ok ? "" : msg.error}`);
    assert.ok(existsSync(join(dir, "readability-overlay.names.json")), "the worker must have written the P-59 overlay sidecar");

    const after = verifyProject(db, dir, { full: true });
    assert.equal(after.ok, true, after.full?.detail.join("; "));
    assert.equal(after.full?.readability.checked, 2, "the worker adds no readability transaction (a name proposal has none)");
    assert.deepEqual(after.full?.readability.problems, []);
    assert.deepEqual(
      after.shards.map((s) => s.path),
      before.shards.map((s) => s.path),
      "the overlay sidecar is not a shard and must never appear in the shard walk",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
