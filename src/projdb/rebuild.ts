// src/projdb/rebuild.ts — `hbcproj rebuild`: docs/specs/18-project-storage-
// integrity.md §6 step 1 / §8 "Recovery / fresh clone" / §9 `rebuild` verb /
// §R4 step 1. The JSON->DB recovery direction: `analysis/` + `log/` are the
// durable authority (§3/§8), `cache.db` is disposable; this regenerates the
// annotation stratum (`revisions` + `d_*` + `log`) of an EMPTY `.hbcproj`
// from them. Intended target is a fresh DB (a brand-new file, or one just
// created by `openProjectDb` on a path that didn't exist) — `revisions`/
// `log` are append-only (schema.sql §2.5 triggers forbid UPDATE/DELETE), so
// rebuild cannot wipe-in-place a populated DB; the recovery scenario itself
// is always "cache.db absent or corrupt" (§8), i.e. always a fresh file.
//
// What CAN be reconstructed exactly, and what can't (a real limitation of
// step-0's export format, not of this module): `analysis/*.json` shards only
// carry the CURRENTLY ACTIVE value per record (§3); `log/*.jsonl` carries
// every historical write's rid/ts/op/actor/kind/target but never its VALUE
// once superseded (export.ts's "known step-0 simplification"). So rebuild
// reconstructs:
//   - one real, content-bearing, QUERYABLE `revisions` row per active shard
//     entry, at its ORIGINAL `rid` (so a subsequent `export` reproduces the
//     same rid/ts/prov and is byte-identical, §R3 metric 1), in the slot the
//     normal write verbs (`annotations.ts`) would compute for it, with its
//     `d_*` detail row filled in from the shard's own fields;
//   - one INERT placeholder `revisions` row per non-active (superseded or
//     revert-bookkeeping) log entry, at its original rid, `cleared=1` so it
//     is invisible to `v_active`/`DbRevisionStore.allRecords()` — it exists
//     only so `log.rid` still has a `revisions` row to join against (schema
//     FK) and so `export`'s log pass recomputes the identical `kind`/
//     `target` for that historical rid. It carries no `d_*` row and no
//     supersession chain: `history()` on an already-superseded slot is
//     necessarily incomplete after a rebuild (the old VALUE was never
//     durable outside cache.db pre-crash) — a documented gap for step 2
//     ("write-path export", R4) to close by exporting every write, not just
//     the final state.
//   - the `log` table verbatim: rid/ts/op/actor straight from the JSONL;
//     `detail` is deterministically `JSON.stringify({kind})`, matching
//     `DbRevisionStore`'s own `appendLog` exactly (revision-store.ts), so
//     `stateBindingOf`'s hash over the whole log table reproduces byte-for-
//     byte (export.ts).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bookmarkAdapter, commentAdapter, findingAdapter, nameAdapter, tagAdapter } from "./annotations.ts";
import type { BookmarkValue, CommentRangeValue, CommentValue, FindingValue, NameValue, TagValue } from "./annotations.ts";
import type { RevisionKind } from "./revision-store.ts";

interface ShardProv {
  readonly source: "human" | "llm" | "tool";
  readonly who: string;
  readonly run?: string | null;
}

interface ActiveRecord {
  readonly rid: number;
  readonly kind: RevisionKind;
  readonly target: string;
  readonly ts: string;
  readonly prov: ShardProv;
  readonly value: unknown;
}

interface LogEntry {
  readonly seq: number;
  readonly ts: string;
  readonly op: string;
  readonly actor: ShardProv;
  readonly kind?: RevisionKind;
  readonly target?: string;
  readonly rid: string;
}

export interface RebuildResult {
  /** How many `revisions` rows were written back (active + placeholder). */
  readonly revisionsWritten: number;
  /** How many of those are the real, content-bearing active rows. */
  readonly activeWritten: number;
  /** How many `log` rows were written back. */
  readonly logEntriesWritten: number;
  /** Non-fatal inconsistencies found between `log/` and `analysis/`
   *  (e.g. a log entry's kind/target disagreeing with the shard's) — surfaced
   *  rather than silently ignored, but rebuild still completes best-effort. */
  readonly warnings: readonly string[];
}

function readJsonFilesIn(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown);
}

/** Every `analysis/**` active record, keyed by its `rid` (globally unique —
 *  it is the `revisions.rid` it was minted at, §5/§7). */
function collectActiveRecords(analysisDir: string): Map<number, ActiveRecord> {
  const out = new Map<number, ActiveRecord>();

  for (const raw of readJsonFilesIn(join(analysisDir, "names"))) {
    const shard = raw as { entries?: Record<string, { name: string; rid: string; ts: string; prov: ShardProv }> };
    for (const [target, e] of Object.entries(shard.entries ?? {})) {
      out.set(Number(e.rid), { rid: Number(e.rid), kind: "name", target, ts: e.ts, prov: e.prov, value: { name: e.name } satisfies NameValue });
    }
  }

  for (const raw of readJsonFilesIn(join(analysisDir, "annotations"))) {
    const shard = raw as {
      tags?: readonly { target: string; tag: string; note?: string; rid: string; ts: string; prov: ShardProv }[];
      comments?: readonly { target: string; body: string; range?: CommentRangeValue; rid: string; ts: string; prov: ShardProv }[];
      bookmarks?: readonly { target: string; label?: string; rid: string; ts: string; prov: ShardProv }[];
    };
    for (const t of shard.tags ?? []) {
      out.set(Number(t.rid), { rid: Number(t.rid), kind: "tag", target: t.target, ts: t.ts, prov: t.prov, value: { tag: t.tag, ...(t.note !== undefined ? { note: t.note } : {}) } satisfies TagValue });
    }
    for (const c of shard.comments ?? []) {
      out.set(Number(c.rid), { rid: Number(c.rid), kind: "comment", target: c.target, ts: c.ts, prov: c.prov, value: { body: c.body, ...(c.range !== undefined ? { range: c.range } : {}) } satisfies CommentValue });
    }
    for (const b of shard.bookmarks ?? []) {
      out.set(Number(b.rid), { rid: Number(b.rid), kind: "bookmark", target: b.target, ts: b.ts, prov: b.prov, value: (b.label !== undefined ? { label: b.label } : {}) satisfies BookmarkValue });
    }
  }

  for (const raw of readJsonFilesIn(join(analysisDir, "findings"))) {
    const shard = raw as { target: string; findingNo: number; severity: string; status: string; claim: string; evidence: readonly { ref: string; role: string }[]; rid: string; ts: string; prov: ShardProv };
    out.set(Number(shard.rid), {
      rid: Number(shard.rid),
      kind: "finding",
      target: shard.target,
      ts: shard.ts,
      prov: shard.prov,
      value: { findingNo: shard.findingNo, severity: shard.severity, status: shard.status, claim: shard.claim, evidence: shard.evidence } satisfies FindingValue,
    });
  }

  return out;
}

/** Every `log/*.jsonl` entry, in global rid order — day files sort
 *  lexicographically by name and, within a file, lines are already
 *  rid-ascending (export.ts's `exportLog`), so concatenating sorted files in
 *  line order reproduces the DB's original global `log` order exactly. */
function collectLogEntries(logDir: string): LogEntry[] {
  if (!existsSync(logDir)) return [];
  const out: LogEntry[] = [];
  for (const f of readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const text = readFileSync(join(logDir, f), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as LogEntry);
    }
  }
  return out;
}

function slotFor(kind: RevisionKind, target: string, value: unknown): string {
  switch (kind) {
    case "name":
      return `name:${target}`;
    case "tag":
      return `tag:${target}:${(value as TagValue).tag}`;
    case "comment": {
      const range = (value as CommentValue).range;
      if (range === undefined) return `comment:${target}`;
      return range.col !== undefined ? `comment:${target}:${range.line}:${range.col}` : `comment:${target}:${range.line}`;
    }
    case "bookmark":
      return `bookmark:${target}`;
    case "finding":
      // patternId (annotations.ts's optional discriminator) is not carried
      // by the finding shard — only `target` is. Every current write path
      // calls `dbSetFinding` without one, so this is exact in practice;
      // documented as a known gap for a caller that does pass one.
      return `finding:${target}`;
    default:
      return `${kind}:${target}`;
  }
}

const detailAdapters = { name: nameAdapter, tag: tagAdapter, comment: commentAdapter, bookmark: bookmarkAdapter, finding: findingAdapter } as const;

function insertRevisionRow(
  db: DatabaseSync,
  rid: number,
  kind: RevisionKind,
  target: string,
  slot: string,
  prov: ShardProv,
  ts: string,
  cleared: 0 | 1,
): void {
  db.prepare(
    `INSERT INTO revisions
       (rid, kind, target, slot, prov_source, prov_who, prov_run, ts,
        supersedes, reactivates, cleared, ctx_name, ctx_loc, ctx_owner, legacy_rid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL)`,
  ).run(rid, kind, target, slot, prov.source, prov.who, prov.run ?? null, ts, cleared);
}

function insertLogRow(db: DatabaseSync, rid: number, ts: string, actor: ShardProv, op: string, kind: RevisionKind | undefined): void {
  db.prepare(`INSERT INTO log (ts, actor_source, actor_who, actor_run, op, rid, gen, detail) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`).run(
    ts,
    actor.source,
    actor.who,
    actor.run ?? null,
    op,
    rid,
    JSON.stringify({ kind: kind ?? null }),
  );
}

/** Regenerates `db`'s annotation stratum (`revisions`/`d_*`/`log`) from
 *  `<projectDir>/analysis/**` + `<projectDir>/log/*.jsonl` (§6 step 1, §8
 *  "Recovery / fresh clone" — the JSON wins because it's all that exists).
 *  `db` must be a FRESH `.hbcproj` (no prior `revisions`/`log` rows) — see
 *  module header on why (append-only triggers forbid in-place wipe).
 *  Deterministic: re-running on the same shards produces the same rows, and
 *  a subsequent `exportProject(db, projectDir)` reproduces the source
 *  shards byte-identically (§R3 metric 1) because every active row keeps
 *  its original rid/ts/prov and the `log` table is replayed verbatim. */
export function rebuildProject(db: DatabaseSync, projectDir: string): RebuildResult {
  const analysisDir = join(projectDir, "analysis");
  const logDir = join(projectDir, "log");
  const active = collectActiveRecords(analysisDir);
  const logEntries = collectLogEntries(logDir);
  const warnings: string[] = [];
  const seenRid = new Set<number>();

  db.exec("BEGIN;");
  try {
    for (const entry of logEntries) {
      const rid = Number(entry.rid);
      seenRid.add(rid);
      const activeRec = active.get(rid);
      const isActive = entry.op === "annotate" && activeRec !== undefined;
      if (isActive) {
        const rec = activeRec;
        if (entry.kind !== undefined && entry.kind !== rec.kind) warnings.push(`rid ${rid}: log kind '${entry.kind}' != shard kind '${rec.kind}'`);
        if (entry.target !== undefined && entry.target !== rec.target) warnings.push(`rid ${rid}: log target '${entry.target}' != shard target '${rec.target}'`);
        const slot = slotFor(rec.kind, rec.target, rec.value);
        insertRevisionRow(db, rid, rec.kind, rec.target, slot, rec.prov, rec.ts, 0);
        (detailAdapters[rec.kind as keyof typeof detailAdapters].writeDetail as (db: DatabaseSync, rid: number, value: unknown) => void)(db, rid, rec.value);
        insertLogRow(db, rid, entry.ts, entry.actor, entry.op, rec.kind);
      } else {
        const kind = entry.kind ?? "name";
        const target = entry.target ?? "";
        insertRevisionRow(db, rid, kind, target, `hist:${kind}:${rid}`, entry.actor, entry.ts, 1);
        insertLogRow(db, rid, entry.ts, entry.actor, entry.op, entry.kind);
      }
    }

    // Any active shard record whose rid never showed up in `log/` (a data
    // gap the log-chain check in verify.ts should already have flagged) —
    // still land it so the DB is at least as complete as `analysis/` claims.
    for (const rec of active.values()) {
      if (seenRid.has(rec.rid)) continue;
      warnings.push(`rid ${rec.rid}: active in ${rec.kind} shard but missing from log/ — inserted without a log row`);
      const slot = slotFor(rec.kind, rec.target, rec.value);
      insertRevisionRow(db, rec.rid, rec.kind, rec.target, slot, rec.prov, rec.ts, 0);
      (detailAdapters[rec.kind as keyof typeof detailAdapters].writeDetail as (db: DatabaseSync, rid: number, value: unknown) => void)(db, rec.rid, rec.value);
    }

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return {
    revisionsWritten: seenRid.size + [...active.values()].filter((r) => !seenRid.has(r.rid)).length,
    activeWritten: active.size,
    logEntriesWritten: logEntries.length,
    warnings,
  };
}
