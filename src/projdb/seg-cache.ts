// src/projdb/seg-cache.ts — persistence for `GET /api/segregation`'s
// name-recovery tree (MIGRATION 4, `schema.sql`; docs/UI.md segregation
// section). OPERATIONAL cache, not authoritative analysis (see the
// migration block's own comment): a miss, a stale invalidation key, or a
// pre-migration DB that has no `seg_modules` table yet are all treated
// identically by the caller (`src/ui-server/segregation.ts`) — recompute
// and overwrite, never an error. This file owns the SQL only; it knows
// nothing about `segregateSplitTree`, workers, or the HTTP route.
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The row shape `seg_modules` round-trips — a structural subset of
 *  `SegregationRow` (`src/ui-server/segregation.ts`) so this file has no
 *  import-time dependency on that module (only a shape it must match). */
export interface SegCacheRow {
  readonly id: number;
  readonly path: string;
  readonly bucket: string;
  readonly package: string | null;
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

export interface SegCacheEntry {
  readonly modules: readonly SegCacheRow[];
  readonly depsApplied: boolean;
}

/** A hash over the module tree a segregation result was computed from: the
 *  sorted list of `*.js`/`MODULES.json` file names in `dir` paired with
 *  each file's byte size (cheap — one `stat`, not a content read — and
 *  changes whenever a module is added, removed, or its emitted text
 *  changes size, which covers the overwhelming majority of real edits;
 *  docs/UI.md documents the residual gap: a same-size content edit is not
 *  detected). Combined in `segCacheKey` below with a deps identity so a
 *  deps-aware cache entry is invalidated by either input changing. */
export function moduleTreeKey(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith(".js") || e.name === "MODULES.json"))
      .map((e) => e.name)
      .sort();
  } catch {
    return "no-dir";
  }
  const h = createHash("sha256");
  for (const name of names) {
    h.update(name);
    h.update("\0");
    try {
      h.update(String(statSync(join(dir, name)).size));
    } catch {
      h.update("?");
    }
    h.update("\n");
  }
  return h.digest("hex");
}

/** The invalidation key `seg_meta.invalidation_key` stores. Deliberately
 *  tree-only (not also keyed on a deps identity, unlike the brief's first
 *  suggestion): a deps-applied row set can only be validated against a
 *  FRESH `McpResources.depsReport()` run, and that run is itself the ~16 s
 *  cold cost this cache exists to avoid paying again on every restart — so
 *  `segregation.ts` treats "the module tree hasn't changed" as sufficient
 *  to serve a persisted row set (deps-applied or not) at sub-ms speed, and
 *  a stored `deps_applied=1` is trusted as settled across restarts exactly
 *  as it is already trusted as settled for the rest of one process's
 *  lifetime once `applyDepsWhenReady` lands it (`segregation.ts`'s own doc
 *  comment on `SegregationResult.depsApplied`). A `--hbc`/signature-DB
 *  change between restarts is not detected by this key; docs/UI.md records
 *  that as the accepted gap (deleting `project.hbcproj` or the two seg_*
 *  tables forces a full recompute). */
export function segCacheKey(dir: string): string {
  return moduleTreeKey(dir);
}

function hasSegTables(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('seg_modules','seg_meta')")
    .get() as { n: number };
  return row.n === 2;
}

/** Reads the cached row set iff `seg_meta.invalidation_key` equals `key`
 *  exactly. Returns `null` on any miss: no cache yet, a stale key, or (a DB
 *  opened by a pre-MIGRATION-4 build that has not been migrated onto this
 *  code path yet, which should not happen via `openProjectDb` but a defensive
 *  read here costs nothing) missing tables. Never throws. */
export function readSegCache(db: DatabaseSync, key: string): SegCacheEntry | null {
  try {
    if (!hasSegTables(db)) return null;
    const metaKey = db.prepare("SELECT value FROM seg_meta WHERE key = 'invalidation_key'").get() as { value: string } | undefined;
    if (metaKey === undefined || metaKey.value !== key) return null;
    const depsRow = db.prepare("SELECT value FROM seg_meta WHERE key = 'deps_applied'").get() as { value: string } | undefined;
    const depsApplied = depsRow?.value === "1";
    const rows = db.prepare("SELECT id, path, bucket, package, name_signal, name_confidence FROM seg_modules ORDER BY id").all() as {
      id: number;
      path: string;
      bucket: string;
      package: string | null;
      name_signal: string | null;
      name_confidence: number | null;
    }[];
    const modules: SegCacheRow[] = rows.map((r) => ({
      id: r.id,
      path: r.path,
      bucket: r.bucket,
      package: r.package,
      nameSignal: r.name_signal,
      nameConfidence: r.name_confidence,
    }));
    return { modules, depsApplied };
  } catch {
    return null;
  }
}

/** Overwrites the cached row set: `DELETE` + re-`INSERT` `seg_modules`
 *  (there is no natural way to diff two segregation runs, and the table is
 *  small relative to a re-segregate, so a full replace inside one
 *  transaction is simplest and correct) and upserts the two `seg_meta`
 *  rows. Swallows write failures — a project DB this route cannot write to
 *  (readonly filesystem, `--split` artifact with no DB) must not turn
 *  `/api/segregation` into a 500; the in-memory result the caller already
 *  has is served regardless of whether persistence succeeded. */
export function writeSegCache(db: DatabaseSync, key: string, entry: SegCacheEntry): void {
  try {
    if (!hasSegTables(db)) return;
    db.exec("BEGIN;");
    try {
      db.exec("DELETE FROM seg_modules;");
      const insert = db.prepare(
        "INSERT INTO seg_modules (id, path, bucket, package, name_signal, name_confidence) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const m of entry.modules) insert.run(m.id, m.path, m.bucket, m.package, m.nameSignal, m.nameConfidence);
      const upsertMeta = db.prepare(
        "INSERT INTO seg_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      upsertMeta.run("invalidation_key", key);
      upsertMeta.run("deps_applied", entry.depsApplied ? "1" : "0");
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } catch {
    /* persistence is best-effort — see doc comment above */
  }
}
