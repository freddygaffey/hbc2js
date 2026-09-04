// tests/projdb/seg-cache.test.ts — MIGRATION 4 (`src/projdb/schema.sql`) +
// `src/projdb/seg-cache.ts`: the persisted `/api/segregation` cache. Applies
// to a fresh DB and to a minor-3 DB the same way `tests/workers/
// storage.test.ts` exercises MIGRATION 2, and round-trips rows through
// `readSegCache`/`writeSegCache` — never a literal-string compare against a
// shared fixture's decompiled output (CLAUDE.md testing rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, migrationSql, SCHEMA_MINOR, SCHEMA_VERSION } from "../../src/projdb/db.ts";
import { moduleTreeKey, segCacheKey, readSegCache, writeSegCache } from "../../src/projdb/seg-cache.ts";
import { repoRoot } from "../support/paths.ts";

const SCHEMA_SQL = join(repoRoot(), "src", "projdb", "schema.sql");

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

test("MIGRATION 4 applies to a fresh DB", () => {
  const db = openProjectDb(":memory:");
  assert.ok(tables(db).includes("seg_modules"));
  assert.ok(tables(db).includes("seg_meta"));
  assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_minor'").get() as { value: string }).value, String(SCHEMA_MINOR));
  db.close();
});

/** A project DB at schema minor 3: the shipped DDL with the MIGRATION 4
 *  block cut out, mirroring `tests/workers/storage.test.ts`'s
 *  `buildOldProject` for MIGRATION 2. */
function buildMinor3Project(dir: string): string {
  const ddl = readFileSync(SCHEMA_SQL, "utf8");
  const cut = ddl.indexOf("-- >>> MIGRATION 4 >>>");
  assert.ok(cut > 0, "schema.sql must carry the MIGRATION 4 markers");
  const path = join(dir, "old.hbcproj");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(ddl.slice(0, cut));
  const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("schema", SCHEMA_VERSION);
  insert.run("schema_minor", "3");
  insert.run("created_at", "2026-09-04T00:00:00.000Z");
  db.close();
  return path;
}

test("MIGRATION 4 applies to a minor-3 DB, migrated forward in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seg-cache-migrate-"));
  try {
    const path = buildMinor3Project(dir);
    {
      const old = new DatabaseSync(path, { readOnly: true });
      assert.ok(!tables(old).includes("seg_modules"), "seg_modules must not exist before the migration");
      old.close();
    }
    const db = openProjectDb(path);
    assert.ok(tables(db).includes("seg_modules"));
    assert.ok(tables(db).includes("seg_meta"));
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='schema_minor'").get() as { value: string }).value, String(SCHEMA_MINOR));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the MIGRATION 4 block is idempotent", () => {
  const db = openProjectDb(":memory:");
  assert.doesNotThrow(() => db.exec(migrationSql(4)));
  assert.doesNotThrow(() => db.exec(migrationSql(4)));
  db.close();
});

test("seg_modules/seg_meta round-trip through readSegCache/writeSegCache", () => {
  const db = openProjectDb(":memory:");
  const key = "tree-key-1";
  assert.equal(readSegCache(db, key), null, "nothing cached yet");
  writeSegCache(db, key, {
    depsApplied: false,
    modules: [
      { id: 0, path: "src/screens/HomeScreen.js", bucket: "src", package: null, nameSignal: "filename", nameConfidence: 0.9 },
      { id: 1, path: "node_modules/react/index.js", bucket: "node_modules", package: "react", nameSignal: null, nameConfidence: null },
    ],
  });
  const hit = readSegCache(db, key);
  assert.notEqual(hit, null);
  assert.equal(hit!.depsApplied, false);
  assert.equal(hit!.modules.length, 2);
  assert.deepEqual(hit!.modules[0], { id: 0, path: "src/screens/HomeScreen.js", bucket: "src", package: null, nameSignal: "filename", nameConfidence: 0.9 });
  assert.deepEqual(hit!.modules[1], { id: 1, path: "node_modules/react/index.js", bucket: "node_modules", package: "react", nameSignal: null, nameConfidence: null });

  // A later write REPLACES the row set (e.g. the deps-aware recompute).
  writeSegCache(db, key, {
    depsApplied: true,
    modules: [{ id: 0, path: "src/screens/HomeScreen.js", bucket: "src", package: null, nameSignal: "filename", nameConfidence: 0.9 }],
  });
  const hit2 = readSegCache(db, key);
  assert.equal(hit2!.depsApplied, true);
  assert.equal(hit2!.modules.length, 1);
  db.close();
});

test("an invalidation key mismatch is treated as a miss, not stale data", () => {
  const db = openProjectDb(":memory:");
  writeSegCache(db, "key-a", { depsApplied: false, modules: [{ id: 0, path: "src/x.js", bucket: "src", package: null, nameSignal: null, nameConfidence: null }] });
  assert.notEqual(readSegCache(db, "key-a"), null);
  assert.equal(readSegCache(db, "key-b"), null, "a different key must miss even though rows exist under a different key");
  db.close();
});

test("moduleTreeKey/segCacheKey changes when the module tree changes (add/remove/resize)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-seg-cache-tree-"));
  try {
    writeFileSync(join(dir, "module_0.js"), "// a");
    const k1 = segCacheKey(dir);
    writeFileSync(join(dir, "module_0.js"), "// a longer body changes the size");
    const k2 = segCacheKey(dir);
    assert.notEqual(k1, k2, "resizing a module file must change the key");
    writeFileSync(join(dir, "module_1.js"), "// b");
    const k3 = segCacheKey(dir);
    assert.notEqual(k2, k3, "adding a module file must change the key");
    // Non-.js/MODULES.json files are ignored.
    mkdirSync(join(dir, "analysis"));
    const k4 = segCacheKey(dir);
    assert.equal(k3, k4, "a sibling directory must not affect the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moduleTreeKey of a missing directory is stable, not a throw", () => {
  assert.equal(moduleTreeKey("/no/such/dir/at/all"), moduleTreeKey("/still/no/such/dir"));
});
