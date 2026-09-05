// src/projdb/db.ts — hbc2js project DB v1 open/create/verify layer
// (docs/specs/16-project-db.md §1.1, §2). Applies `schema.sql` verbatim to a
// fresh `project.hbcproj`, sets the identity pragmas (`application_id`,
// `user_version`) + the storage pragmas (`journal_mode=WAL`,
// `foreign_keys=ON`, `page_size=8192`), and writes the `meta.schema` row.
// Re-opening an existing file verifies `application_id`/`user_version`/
// `meta.schema` and REFUSES a mismatch rather than silently re-initialising
// or guessing (spec 10 §1.1 rule, restated at §1.1 here). Mirrors
// `src/deps/sigdb-sql.ts`'s `openSigDb` conventions.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `PRAGMA application_id` value: the ASCII bytes "HBRP" read big-endian. */
export const APPLICATION_ID = 0x48425250;
/** `PRAGMA user_version`: the major schema version (§1.1). */
export const USER_VERSION = 1;
/** `meta.schema` row value. */
export const SCHEMA_VERSION = "hbc2js-proj/1";
/** `meta.schema_minor` row value — the ADDITIVE schema minor within the
 *  `user_version`/`meta.schema` major. Minor 1 is the original v1 DDL; minor 2
 *  adds the worker/session operational stratum (`sessions`, `jobs`, `claims`,
 *  `worker_events` — docs/specs/23-ui-workers.md §3/§4.1); minor 3 adds
 *  `revision_tier` (docs/specs/17-mcp-harness.md §15 — the provenance
 *  `tier: "suggested"|"accepted"` follow-up spec 23 §4 recorded); minor 4 adds
 *  `seg_modules`/`seg_meta`, the persisted `/api/segregation` cache
 *  (`src/projdb/seg-cache.ts`, docs/UI.md segregation section) so a
 *  ui-server restart serves the name-recovery tree from the DB instead of
 *  recomputing it; minor 5 adds `ix_calls_resolved`, the `require(N)`
 *  points-to pass's edges (docs/BUGS.md 2026-09-05 `ix_calls_resolved` row,
 *  `src/artifact/points-to.ts`) — until this minor a DB-backed artifact
 *  served zero points-to edges while the JSONL path served them. A minor bump is
 *  additive BY DEFINITION: it may only create new objects, never alter or drop
 *  an existing one, so an older DB is migrated forward in place (§`migrateProjectDb`)
 *  and a NEWER minor still opens read/write with this build (its extra tables are
 *  simply unused) — unlike a major mismatch, which is refused. */
export const SCHEMA_MINOR = 5;

export class ProjectDbVersionError extends Error {}

function schemaSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
}

/** The DDL block for one schema minor, sliced out of `schema.sql` between its
 *  `-- >>> MIGRATION n >>>` / `-- <<< MIGRATION n <<<` markers. One source of
 *  truth: a fresh DB gets the block by applying the whole file, an older DB
 *  gets exactly the same text re-applied by `migrateProjectDb`. Every
 *  statement in a migration block is `IF NOT EXISTS`, so re-application is a
 *  no-op. Minor 1 is the pre-marker body of the file and has no block. */
export function migrationSql(minor: number): string {
  if (minor <= 1) return "";
  const ddl = readFileSync(schemaSqlPath(), "utf8");
  const start = ddl.indexOf(`-- >>> MIGRATION ${minor} >>>`);
  const end = ddl.indexOf(`-- <<< MIGRATION ${minor} <<<`);
  if (start < 0 || end < 0 || end < start) {
    throw new ProjectDbVersionError(`migrationSql: schema.sql has no MIGRATION ${minor} block`);
  }
  return ddl.slice(start, end);
}

function readMinor(db: DatabaseSync): number {
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = 'schema_minor'").get() as { value: string } | undefined;
  } catch {
    row = undefined;
  }
  const n = row === undefined ? 1 : Number.parseInt(row.value, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Brings an already-identity-verified DB up to `SCHEMA_MINOR` by applying each
 *  missing migration block (§`migrationSql`) in one transaction and recording
 *  the new `meta.schema_minor`. Returns the minor the DB is at afterwards. A DB
 *  already at (or beyond) `SCHEMA_MINOR` is untouched — this is a pure
 *  forward, additive migration: no existing row is read, rewritten or deleted,
 *  so it cannot disturb the annotation/log strata or their append-only
 *  triggers (docs/specs/23-ui-workers.md §4.1). */
export function migrateProjectDb(db: DatabaseSync): number {
  const from = readMinor(db);
  if (from >= SCHEMA_MINOR) return from;
  db.exec("BEGIN;");
  try {
    for (let m = from + 1; m <= SCHEMA_MINOR; m++) db.exec(migrationSql(m));
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_minor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(SCHEMA_MINOR),
    );
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
  return SCHEMA_MINOR;
}

/** Opens (creating if absent) a project DB at `path`. A fresh file gets the
 *  §2 DDL applied verbatim inside one transaction, plus the §1.1 pragmas and
 *  `meta` identity rows (`schema`, `created_at`). Re-opening an existing file
 *  verifies `application_id`, `user_version`, and `meta.schema` all match —
 *  any mismatch throws `ProjectDbVersionError` (refuse, don't guess). */
export function openProjectDb(path: string): DatabaseSync {
  const isNew = path === ":memory:" || !existsSync(path);
  const db = new DatabaseSync(path);
  // page_size only takes effect before any tables exist; set first.
  db.exec("PRAGMA page_size=8192;");
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  if (isNew) {
    // schema.sql itself sets application_id/user_version (so A1's bare
    // `db.exec(ddl)` is self-sufficient); this call applies the same DDL.
    const ddl = readFileSync(schemaSqlPath(), "utf8");
    db.exec("BEGIN;");
    try {
      db.exec(ddl);
      const now = new Date().toISOString();
      const insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      insertMeta.run("schema", SCHEMA_VERSION);
      insertMeta.run("schema_minor", String(SCHEMA_MINOR));
      insertMeta.run("created_at", now);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } else {
    verifyProjectDb(db, path);
    // Additive minors are migrated in place on open: a project written by an
    // older build must keep opening (docs/specs/23-ui-workers.md §8).
    migrateProjectDb(db);
  }
  return db;
}

/** Verifies an already-open DB's identity: `application_id`, `user_version`,
 *  and `meta.schema` (§1.1). Throws `ProjectDbVersionError` on any mismatch,
 *  including a missing `meta` table (not a project DB at all). */
export function verifyProjectDb(db: DatabaseSync, path: string): void {
  const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number })
    .application_id;
  if (appId !== APPLICATION_ID) {
    throw new ProjectDbVersionError(
      `openProjectDb: ${path} has application_id=${appId}, expected ${APPLICATION_ID} ("HBRP") — not a project.hbcproj`,
    );
  }
  const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (userVersion !== USER_VERSION) {
    throw new ProjectDbVersionError(
      `openProjectDb: ${path} has user_version=${userVersion}, this build expects ${USER_VERSION} — refusing to guess at an unknown major`,
    );
  }
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
      | { value: string }
      | undefined;
  } catch {
    row = undefined;
  }
  if (row === undefined || row.value !== SCHEMA_VERSION) {
    throw new ProjectDbVersionError(
      `openProjectDb: ${path} exists but is not a ${SCHEMA_VERSION} project DB (meta.schema='${row?.value ?? "<missing>"}')`,
    );
  }
}
