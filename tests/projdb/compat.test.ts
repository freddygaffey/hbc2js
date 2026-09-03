// tests/projdb/compat.test.ts — docs/specs/16-project-db.md §7 A5:
// plain-SQLite compatibility. `project.hbcproj` is an ordinary SQLite file —
// file header bytes are `SQLite format 3\0`; a fresh, independent
// `node:sqlite` readonly connection (standing in for any stock tool) can
// `SELECT` from every table and every view without any hbc2js code loaded;
// if a `sqlite3` binary is on PATH, also shell out `.tables` + one view
// SELECT (skipped, not failed, when absent — mac/Linux rule, CLAUDE.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { splitProject } from "../../src/split/index.ts";
import { repoRoot } from "../support/paths.ts";
import { readFileSync } from "node:fs";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-compat-"));
const dbPath = join(outDir, "project.hbcproj");
{
  const db = openProjectDb(dbPath);
  initProjectDb(db, rows, { actorWho: "test" });
  db.close();
}

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("A5 file header bytes are 'SQLite format 3\\0'", () => {
  const fd = openSync(dbPath, "r");
  const buf = Buffer.alloc(16);
  readSync(fd, buf, 0, 16, 0);
  closeSync(fd);
  assert.equal(buf.toString("utf8"), "SQLite format 3\0");
});

test("A5 an independent readonly node:sqlite connection selects every table", () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("meta"));
  assert.ok(tables.includes("log"));
  assert.ok(tables.includes("revisions"));
  assert.ok(tables.includes("ix_functions"));
  assert.ok(tables.includes("ix_calls"));
  for (const t of tables) {
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${t} LIMIT 1`).all(), `SELECT from table ${t} failed`);
  }
  db.close();
});

test("A5 an independent readonly node:sqlite connection selects every view", () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const views = (db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.ok(views.includes("v_json_calls"));
  assert.ok(views.includes("v_active"));
  for (const v of views) {
    assert.doesNotThrow(() => db.prepare(`SELECT * FROM ${v} LIMIT 5`).all(), `SELECT from view ${v} failed`);
  }
  // v_json_* rows are all parseable JSON (mirrors A1e, on a real build).
  const callRows = db.prepare("SELECT j FROM v_json_calls").all() as { j: string }[];
  for (const r of callRows) assert.doesNotThrow(() => JSON.parse(r.j));
  db.close();
});

test("A5 a stock sqlite3 binary (when present) reads .tables and a view SELECT", () => {
  let sqlite3Path: string | undefined;
  try {
    sqlite3Path = execFileSync("which", ["sqlite3"], { encoding: "utf8" }).trim();
  } catch {
    sqlite3Path = undefined;
  }
  if (sqlite3Path === undefined || sqlite3Path.length === 0) {
    // mac/Linux rule (CLAUDE.md): skip, never fail, when the tool is absent.
    return;
  }
  const tablesOut = execFileSync(sqlite3Path, [dbPath, ".tables"], { encoding: "utf8" });
  assert.match(tablesOut, /ix_functions/);
  const selectOut = execFileSync(sqlite3Path, [dbPath, "SELECT COUNT(*) FROM v_json_functions;"], { encoding: "utf8" });
  assert.match(selectOut.trim(), /^\d+$/);
});
