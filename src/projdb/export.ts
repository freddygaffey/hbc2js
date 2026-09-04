// src/projdb/export.ts — `hbcproj export`: docs/specs/18-project-storage-
// integrity.md §6 step 3 / §9 `export` verb / §R4 implementation-plan step 0
// ("`export` + hash lock"). Materialises the git-tracked `analysis/` +
// `log/` shards from an already-open `.hbcproj` DB (the c02c1b3 substrate:
// `src/projdb/annotations.ts`'s write verbs + `src/projdb/revision-store.ts`'s
// `DbRevisionStore`) — this is the READ-OUT half; the DB write path itself
// is unchanged.
//
// Shard layout (§3):
//   analysis/names/<module>.json        active {fn,reg,env}->name, per module
//   analysis/annotations/<module>.json  active tags/comments/bookmarks, per module
//   analysis/findings/<id>.json         one file per finding, content-hash id (§7)
//   log/<date>.jsonl                    the DB `log` table, day-sharded, hash-chained (§5)
//
// Determinism (§14 "re-export of unchanged state is a no-op"): every shard
// is `JSON.stringify`d with recursively sorted object keys
// (`canonicalJson`/`sortKeysDeep`) and a trailing newline; a re-export whose
// content is byte-identical to the file on disk is skipped (not rewritten),
// so an unchanged DB state produces zero git diff.
//
// Per-shard integrity (§5): every shard/log-entry carries a `contentHash`
// (sha256 of its own canonical JSON, everything except the hash field
// itself — self-contained, no DB needed to check it) and a `stateBinding`
// (the DB's log-table high-water-mark `dbVersion` + a `stateHash` over the
// whole `log` table at export time) — every shard from one export call
// shares the same `stateBinding`, so they are all provably tied to the same
// DB state.
//
// Finding ids (§7): content-hash of ONLY the fields §7 names as immutable —
// `target`, `kind`, `evidence` (ref+role, order-preserving: reordering
// evidence is a different anchor) — never `status`/`severity`/`claim`, so an
// id survives a status transition (tests/projdb/export.test.ts).
//
// Known step-0 simplification (deferred to §R4 step 2, "write-path export +
// chained log"): this is a one-shot BULK export, not an incremental
// per-write one. Each `log/` entry's recorded shard hash is the shard's
// hash as of THIS export (the current/final state), not a true historical
// per-write snapshot. For most entries this is exact anyway — a finding's
// shard id is stable across everything but an evidence change (§7), so its
// recorded hash covers its whole status/severity/claim lifecycle. An entry
// whose value has since been fully superseded by a *different* id (e.g. the
// evidence itself changed) has no live shard to point at; its `shards`
// array is empty rather than guessed. True per-write shard hashes are a
// step-2 concern (they require hooking the write path itself, not a
// stand-alone export).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseKey } from "../name-overlay/id.ts";
import { DbRevisionStore } from "./revision-store.ts";
import { bookmarkAdapter, commentAdapter, findingAdapter, nameAdapter, tagAdapter } from "./annotations.ts";
import type { FindingEvidenceValue } from "./annotations.ts";

const UNASSIGNED_MODULE = "_unassigned";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Recursively sorts object keys (arrays keep their element order — order is
 *  meaningful there, e.g. evidence anchors) so the same logical value always
 *  serialises identically. The basis of every content hash and of the
 *  byte-stable shard files this module writes. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** The finding's content-hash id (§7): hashes ONLY `target`+`kind`+
 *  `evidence` (ref+role) — never status/severity/claim/notes — so the id is
 *  stable across the finding's whole lifecycle and two independently-found
 *  identical findings dedup to the same id. */
export function findingContentId(target: string, evidence: readonly FindingEvidenceValue[]): string {
  const basis = { target, kind: "finding" as const, evidence: evidence.map((e) => ({ ref: e.ref, role: e.role })) };
  return `f-${sha256Hex(canonicalJson(basis)).slice(0, 16)}`;
}

function fnOf(target: string): number | null {
  try {
    return parseKey(target).fn;
  } catch {
    return null;
  }
}

/** The module shard name a `target` (a `fn:`/`reg:`/`env:` binding key)
 *  belongs under: `ix_functions.module` -> `ix_modules.file`, sanitised for
 *  use as a filename. Falls back to `_unassigned` when the target doesn't
 *  parse as a binding key, the function has no recorded module (`ix_functions`
 *  not yet built for this project), or the DB has no `ix_functions` row for
 *  it at all — always a valid, deterministic shard. */
function moduleShardName(db: DatabaseSync, target: string): string {
  const fn = fnOf(target);
  if (fn === null) return UNASSIGNED_MODULE;
  const fnRow = db.prepare(`SELECT module FROM ix_functions WHERE fn = ?`).get(fn) as { module: number | null } | undefined;
  if (fnRow === undefined || fnRow.module === null) return UNASSIGNED_MODULE;
  const modRow = db.prepare(`SELECT file FROM ix_modules WHERE id = ?`).get(fnRow.module) as { file: string } | undefined;
  if (modRow === undefined) return `module-${fnRow.module}`;
  return modRow.file.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9_.\-]/g, "_");
}

interface StateBinding {
  readonly dbVersion: number;
  readonly stateHash: string;
}

/** One `stateBinding` (§5) shared by every shard written in a single
 *  `exportProject` call: `dbVersion` is the `log` table's high-water mark
 *  (its own monotonic rid), `stateHash` a hash of the whole `log` table at
 *  that point — so every shard from one export is provably tied to the same
 *  DB state, and re-exporting unchanged state reproduces the same binding
 *  byte-for-byte (part of what makes re-export a no-op). */
function stateBindingOf(db: DatabaseSync): StateBinding {
  const rows = db.prepare(`SELECT rid, ts, op, actor_source, actor_who, actor_run, detail FROM log ORDER BY rid`).all() as {
    rid: number;
  }[];
  const last = rows[rows.length - 1];
  const dbVersion = last !== undefined ? last.rid : 0;
  return { dbVersion, stateHash: sha256Hex(canonicalJson(rows)) };
}

export interface ExportResult {
  /** Shard paths that were created or whose content changed. */
  readonly written: readonly string[];
  /** Shard paths whose freshly-computed content matched what was already on
   *  disk — the re-export-is-a-no-op case (§14). */
  readonly unchanged: readonly string[];
}

/** Writes one hash-locked, state-bound shard (§5) at `path`: `obj` plus the
 *  shared `stateBinding`, plus a `contentHash` over everything else,
 *  pretty-printed with sorted keys. Skips the actual file write (and
 *  reports it under `unchanged`) when the freshly-serialised bytes already
 *  match what's on disk. */
function writeShard(path: string, obj: Record<string, unknown>, binding: StateBinding, result: { written: string[]; unchanged: string[] }): string {
  const withBinding = { ...obj, stateBinding: binding };
  const contentHash = sha256Hex(canonicalJson(withBinding));
  const full = { ...withBinding, contentHash };
  const text = `${JSON.stringify(sortKeysDeep(full), null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (prior === text) {
    result.unchanged.push(path);
  } else {
    writeFileSync(path, text, "utf8");
    result.written.push(path);
  }
  return contentHash;
}

/** Materialises `<projectDir>/analysis/**` + `<projectDir>/log/*.jsonl` from
 *  `db` — the `hbcproj export` verb (§9). `db` must already be open
 *  (`openProjectDb`); this function never touches `cache.db` itself, only
 *  reads it. */
export function exportProject(db: DatabaseSync, projectDir: string): ExportResult {
  const analysisDir = join(projectDir, "analysis");
  const logDir = join(projectDir, "log");
  // The project skeleton (§3) always has `analysis/` + `log/`, even for a
  // brand-new project with no annotations/findings/history yet to shard.
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const binding = stateBindingOf(db);
  const result = { written: [] as string[], unchanged: [] as string[] };

  // A path (relative to `analysisDir`, no extension) -> post-export content
  // hash, for the `log/` pass below (module header's "known step-0
  // simplification").
  const shardHash = new Map<string, string>();

  // --- names, one file per module -------------------------------------
  const namesByModule = new Map<string, Record<string, unknown>>();
  for (const r of new DbRevisionStore(db, nameAdapter).allRecords()) {
    if (!r.active) continue;
    const mod = moduleShardName(db, r.target);
    const entries = namesByModule.get(mod) ?? {};
    entries[r.target] = { name: r.value.name, rid: r.rid, ts: r.ts, prov: r.prov };
    namesByModule.set(mod, entries);
  }
  for (const mod of [...namesByModule.keys()].sort()) {
    const shardId = `names/${mod}`;
    const hash = writeShard(join(analysisDir, "names", `${mod}.json`), { shard: shardId, module: mod, entries: namesByModule.get(mod) }, binding, result);
    shardHash.set(shardId, hash);
  }

  // --- annotations (tags/comments/bookmarks), one file per module -----
  interface AnnBucket {
    tags: Record<string, unknown>[];
    comments: Record<string, unknown>[];
    bookmarks: Record<string, unknown>[];
  }
  const annByModule = new Map<string, AnnBucket>();
  const bucket = (mod: string): AnnBucket => {
    let b = annByModule.get(mod);
    if (b === undefined) {
      b = { tags: [], comments: [], bookmarks: [] };
      annByModule.set(mod, b);
    }
    return b;
  };
  for (const r of new DbRevisionStore(db, tagAdapter).allRecords()) {
    if (!r.active) continue;
    bucket(moduleShardName(db, r.target)).tags.push({ target: r.target, tag: r.value.tag, ...(r.value.note !== undefined ? { note: r.value.note } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  for (const r of new DbRevisionStore(db, commentAdapter).allRecords()) {
    if (!r.active) continue;
    bucket(moduleShardName(db, r.target)).comments.push({ target: r.target, body: r.value.body, ...(r.value.range !== undefined ? { range: r.value.range } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  for (const r of new DbRevisionStore(db, bookmarkAdapter).allRecords()) {
    if (!r.active) continue;
    bucket(moduleShardName(db, r.target)).bookmarks.push({ target: r.target, ...(r.value.label !== undefined ? { label: r.value.label } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  const byTargetRid = (a: { target: string; rid: string }, b: { target: string; rid: string }): number => a.target.localeCompare(b.target) || Number(a.rid) - Number(b.rid);
  for (const mod of [...annByModule.keys()].sort()) {
    const b = annByModule.get(mod);
    if (b === undefined) continue;
    const shardId = `annotations/${mod}`;
    const hash = writeShard(
      join(analysisDir, "annotations", `${mod}.json`),
      {
        shard: shardId,
        module: mod,
        tags: [...b.tags].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
        comments: [...b.comments].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
        bookmarks: [...b.bookmarks].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
      },
      binding,
      result,
    );
    shardHash.set(shardId, hash);
  }

  // --- findings, one file per content-hash id --------------------------
  const findingShardOf = new Map<string, string>(); // rid -> shard id, for the log pass
  for (const r of new DbRevisionStore(db, findingAdapter).allRecords()) {
    const id = findingContentId(r.target, r.value.evidence);
    const shardId = `findings/${id}`;
    findingShardOf.set(r.rid, shardId);
    if (!r.active) continue;
    const hash = writeShard(
      join(analysisDir, "findings", `${id}.json`),
      {
        shard: shardId,
        id,
        target: r.target,
        kind: "finding",
        findingNo: r.value.findingNo,
        severity: r.value.severity,
        status: r.value.status,
        claim: r.value.claim,
        evidence: r.value.evidence,
        rid: r.rid,
        ts: r.ts,
        prov: r.prov,
      },
      binding,
      result,
    );
    shardHash.set(shardId, hash);
  }

  // --- log/<date>.jsonl, day-sharded, hash-chained (§5) ----------------
  exportLog(db, logDir, shardHash, findingShardOf, result);

  return result;
}

interface LogRow {
  readonly rid: number;
  readonly ts: string;
  readonly op: string;
  readonly actor_source: string;
  readonly actor_who: string;
  readonly actor_run: string | null;
  readonly detail: string | null;
}

interface RevTargetRow {
  readonly target: string;
  readonly kind: string;
}

function dayOf(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts);
  return m !== null ? m[1]! : "unknown-date";
}

/** Bulk-materialises the DB's `log` table into `log/<date>.jsonl`,
 *  hash-chained end to end (the chain spans day files: the first entry of
 *  a later day chains from the last entry of the file before it, §5). Each
 *  entry records the shard(s) its `revisions` row affects and — where a
 *  live shard for it still exists post-export — that shard's content hash
 *  (module header's "known step-0 simplification" explains the cases where
 *  it doesn't). */
function exportLog(
  db: DatabaseSync,
  logDir: string,
  shardHash: ReadonlyMap<string, string>,
  findingShardOf: ReadonlyMap<string, string>,
  result: { written: string[]; unchanged: string[] },
): void {
  const rows = db.prepare(`SELECT rid, ts, op, actor_source, actor_who, actor_run, detail FROM log ORDER BY rid`).all() as unknown as LogRow[];
  const byDay = new Map<string, Record<string, unknown>[]>();
  let prevHash = "genesis";
  for (const row of rows) {
    const revRow = db.prepare(`SELECT target, kind FROM revisions WHERE rid = ?`).get(row.rid) as unknown as RevTargetRow | undefined;
    const shards: { path: string; contentHash: string }[] = [];
    if (revRow !== undefined) {
      const shardId =
        revRow.kind === "name"
          ? `names/${moduleShardName(db, revRow.target)}`
          : revRow.kind === "finding"
            ? (findingShardOf.get(String(row.rid)) ?? null)
            : revRow.kind === "tag" || revRow.kind === "comment" || revRow.kind === "bookmark"
              ? `annotations/${moduleShardName(db, revRow.target)}`
              : null;
      if (shardId !== null) {
        const hash = shardHash.get(shardId);
        if (hash !== undefined) shards.push({ path: shardId, contentHash: hash });
      }
    }
    const entry = {
      seq: row.rid,
      ts: row.ts,
      op: row.op,
      actor: { source: row.actor_source, who: row.actor_who, ...(row.actor_run !== null ? { run: row.actor_run } : {}) },
      ...(revRow !== undefined ? { kind: revRow.kind, target: revRow.target } : {}),
      rid: String(row.rid),
      shards,
      prevHash,
    };
    const hash = sha256Hex(canonicalJson(entry));
    const full = { ...entry, hash };
    prevHash = hash;
    const day = dayOf(row.ts);
    const arr = byDay.get(day) ?? [];
    arr.push(full);
    byDay.set(day, arr);
  }
  for (const day of [...byDay.keys()].sort()) {
    const entries = byDay.get(day);
    if (entries === undefined) continue;
    const text = `${entries.map((e) => canonicalJson(e)).join("\n")}\n`;
    const path = join(logDir, `${day}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    const prior = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (prior === text) {
      result.unchanged.push(path);
    } else {
      writeFileSync(path, text, "utf8");
      result.written.push(path);
    }
  }
}
