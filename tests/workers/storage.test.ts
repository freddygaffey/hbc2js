// tests/workers/storage.test.ts — docs/specs/23-ui-workers.md §4.1/§8 and
// docs/specs/18-project-storage-integrity.md §4's boundary rule: the worker
// stratum is OPERATIONAL state. It must (a) migrate into an existing project
// DB without disturbing anything, and (b) be invisible to `export` — no shard,
// no entry in the hash-chained log, so `verify --full`/`rebuild` are
// unaffected by any amount of job churn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, migrationSql, SCHEMA_MINOR, SCHEMA_VERSION } from "../../src/projdb/db.ts";
import { exportProject } from "../../src/projdb/export.ts";
import { JobQueue } from "../../src/workers/queue.ts";
import { Presence } from "../../src/workers/presence.ts";
import { repoRoot } from "../support/paths.ts";

const SCHEMA_SQL = join(repoRoot(), "src", "projdb", "schema.sql");
const WORKER_TABLES = ["sessions", "jobs", "claims", "worker_events"];

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

/** Writes a project DB at the PREVIOUS schema minor: the shipped DDL with the
 *  MIGRATION 2 block cut out, exactly what a project created by an older build
 *  looks like on disk. */
function buildOldProject(dir: string): string {
  const ddl = readFileSync(SCHEMA_SQL, "utf8");
  const cut = ddl.indexOf("-- >>> MIGRATION 2 >>>");
  assert.ok(cut > 0, "schema.sql must carry the MIGRATION 2 markers");
  const path = join(dir, "old.hbcproj");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(ddl.slice(0, cut));
  const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("schema", SCHEMA_VERSION);
  insert.run("created_at", "2026-09-01T00:00:00.000Z");
  insert.run("bundle_sha256", "deadbeef");
  db.close();
  return path;
}

test("a project DB from an older build opens and is migrated in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-workers-migrate-"));
  try {
    const path = buildOldProject(dir);
    {
      const old = new DatabaseSync(path, { readOnly: true });
      for (const t of WORKER_TABLES) assert.ok(!tables(old).includes(t), `${t} must not exist before the migration`);
      old.close();
    }

    const db = openProjectDb(path);
    for (const t of WORKER_TABLES) assert.ok(tables(db).includes(t), `${t} must exist after opening`);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_minor'").get() as { value: string }).value, String(SCHEMA_MINOR));
    // Nothing pre-existing was disturbed.
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='bundle_sha256'").get() as { value: string }).value, "deadbeef");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
    db.close();

    // Re-opening an already-migrated DB is a no-op, not a second migration.
    const again = openProjectDb(path);
    assert.equal((again.prepare("SELECT COUNT(*) AS n FROM meta WHERE key='schema_minor'").get() as { n: number }).n, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migration block is idempotent (every object is IF NOT EXISTS)", () => {
  const db = openProjectDb(":memory:");
  assert.doesNotThrow(() => db.exec(migrationSql(SCHEMA_MINOR)));
  assert.doesNotThrow(() => db.exec(migrationSql(SCHEMA_MINOR)));
  db.close();
});

test("worker rows never reach the log table (§4.1)", () => {
  const db = openProjectDb(":memory:");
  const logBefore = (db.prepare("SELECT COUNT(*) AS n FROM log").get() as { n: number }).n;
  const queue = new JobQueue(db);
  const presence = new Presence(db);
  const s = presence.open({ kind: "worker", who: "worker:explain-fn" });
  presence.claim("fn:188", s.id);
  const job = queue.enqueue({ kind: "explain-fn", input: { fn: 188 }, createdBy: s.id }).job;
  queue.claimNext();
  queue.progress(job.id, 1, 2);
  queue.finish(job.id, { result: { tier: "suggested" } });
  presence.close(s.id);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM log").get() as { n: number }).n, logBefore);
  assert.ok((db.prepare("SELECT COUNT(*) AS n FROM worker_events").get() as { n: number }).n >= 6);
  db.close();
});

test("export writes no shard for sessions/jobs/claims — verify/rebuild are unaffected", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-workers-export-"));
  try {
    const db = openProjectDb(join(dir, "project.hbcproj"));
    const queue = new JobQueue(db);
    const presence = new Presence(db);
    const s = presence.open({ kind: "human", who: "analyst@duck.com" });
    presence.claim("fn:1", s.id);
    queue.enqueue({ kind: "explain-fn", input: { fn: 1 }, createdBy: s.id });

    const result = exportProject(db, dir);
    const paths = [...result.written, ...result.unchanged];
    for (const p of paths) {
      assert.ok(!/session|job|claim/i.test(p), `export must not emit an operational shard: ${p}`);
    }
    const analysis = join(dir, "analysis");
    if (existsSync(analysis)) {
      for (const entry of readdirSync(analysis, { recursive: true, withFileTypes: true }) as { name: string; parentPath?: string; path?: string; isFile(): boolean }[]) {
        if (!entry.isFile()) continue;
        const text = readFileSync(join(entry.parentPath ?? entry.path ?? analysis, entry.name), "utf8");
        assert.ok(!text.includes("idempotency_key"), `an operational field leaked into ${entry.name}`);
        assert.ok(!text.includes("worker_events"), `an operational field leaked into ${entry.name}`);
      }
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema.sql's migration markers stay well-formed (the migration's only contract)", () => {
  const ddl = readFileSync(SCHEMA_SQL, "utf8");
  assert.ok(ddl.includes(`-- >>> MIGRATION ${SCHEMA_MINOR} >>>`));
  assert.ok(ddl.includes(`-- <<< MIGRATION ${SCHEMA_MINOR} <<<`));
  // The worker/session stratum is specifically MIGRATION 2's block (spec 23
  // §3/§4.1) — pinned to `2`, not `SCHEMA_MINOR`, since a LATER round is free
  // to add its own migration (docs/specs/17-mcp-harness.md §15's MIGRATION 3
  // did, for the provenance-tier follow-up) without these worker tables
  // moving; `SCHEMA_MINOR` only names "the current highest migration".
  const block = migrationSql(2);
  for (const t of WORKER_TABLES) assert.ok(block.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `${t} must be created IF NOT EXISTS`);
});
