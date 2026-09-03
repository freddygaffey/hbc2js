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

export class ProjectDbVersionError extends Error {}

function schemaSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
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
      insertMeta.run("created_at", now);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } else {
    verifyProjectDb(db, path);
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
