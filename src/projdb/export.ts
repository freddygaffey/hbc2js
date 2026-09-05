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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseKey } from "../name-overlay/id.ts";
import { DbRevisionStore } from "./revision-store.ts";
import type { DbRevision } from "./revision-store.ts";
import { bookmarkAdapter, commentAdapter, findingAdapter, nameAdapter, tagAdapter } from "./annotations.ts";
import type { FindingEvidenceValue, FindingValue } from "./annotations.ts";

const UNASSIGNED_MODULE = "_unassigned";

/** Exported for `src/projdb/rebuild.ts` and `src/projdb/verify.ts` (§8/§R3):
 *  both need the SAME hash used to lock a shard, either to recompute it
 *  during a hand-edit-vs-lag check, or to reproduce log-entry hashes. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Recursively sorts object keys (arrays keep their element order — order is
 *  meaningful there, e.g. evidence anchors) so the same logical value always
 *  serialises identically. The basis of every content hash and of the
 *  byte-stable shard files this module writes. Exported for the same reason
 *  as `sha256Hex` above. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
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

export interface StateBinding {
  readonly dbVersion: number;
  readonly stateHash: string;
}

/** One `stateBinding` (§5) shared by every shard written in a single
 *  `exportProject` call: `dbVersion` is the `log` table's high-water mark
 *  (its own monotonic rid), `stateHash` a hash of the whole `log` table at
 *  that point — so every shard from one export is provably tied to the same
 *  DB state, and re-exporting unchanged state reproduces the same binding
 *  byte-for-byte (part of what makes re-export a no-op). Exported so
 *  `verify.ts` can read the DB's CURRENT version to classify a shard whose
 *  on-disk `stateBinding.dbVersion` is older as lag (§8), not a hand edit. */
export function stateBindingOf(db: DatabaseSync): StateBinding {
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

/** The `revisions.kind` -> `DetailAdapter` map for every kind the annotation
 *  write verbs (`annotations.ts`) actually mint. Shared by the bulk log pass
 *  below and the write-path incremental exporter (`exportWriteEffect`) so
 *  both read a written record's value the SAME way `rebuild.ts` does. */
const detailAdapters = { name: nameAdapter, tag: tagAdapter, comment: commentAdapter, bookmark: bookmarkAdapter, finding: findingAdapter } as const;

const byTargetRid = (a: { target: string; rid: string }, b: { target: string; rid: string }): number => a.target.localeCompare(b.target) || Number(a.rid) - Number(b.rid);

/** Builds (never writes) the `names/<module>.json` shard's content for a
 *  single module — every ACTIVE name record whose target resolves to `mod`.
 *  Factored out of `exportProject`'s bulk pass so the write-path incremental
 *  exporter (`exportWriteEffect`) can rebuild the ONE affected module shard
 *  using identical logic, guaranteeing byte-identical output either way. */
export function namesShardContent(db: DatabaseSync, mod: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const r of new DbRevisionStore(db, nameAdapter).allRecords()) {
    if (!r.active || moduleShardName(db, r.target) !== mod) continue;
    entries[r.target] = { name: r.value.name, rid: r.rid, ts: r.ts, prov: r.prov };
  }
  return { shard: `names/${mod}`, module: mod, entries };
}

export function writeNamesShard(db: DatabaseSync, analysisDir: string, binding: StateBinding, mod: string, result: { written: string[]; unchanged: string[] }): { shardId: string; hash: string } {
  const shardId = `names/${mod}`;
  const hash = writeShard(join(analysisDir, "names", `${mod}.json`), namesShardContent(db, mod), binding, result);
  return { shardId, hash };
}

/** Same idea as `namesShardContent`, for the combined tags/comments/bookmarks
 *  `annotations/<module>.json` shard. */
export function annotationsShardContent(db: DatabaseSync, mod: string): Record<string, unknown> {
  const tags: Record<string, unknown>[] = [];
  const comments: Record<string, unknown>[] = [];
  const bookmarks: Record<string, unknown>[] = [];
  for (const r of new DbRevisionStore(db, tagAdapter).allRecords()) {
    if (!r.active || moduleShardName(db, r.target) !== mod) continue;
    tags.push({ target: r.target, tag: r.value.tag, ...(r.value.note !== undefined ? { note: r.value.note } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  for (const r of new DbRevisionStore(db, commentAdapter).allRecords()) {
    if (!r.active || moduleShardName(db, r.target) !== mod) continue;
    comments.push({ target: r.target, body: r.value.body, ...(r.value.range !== undefined ? { range: r.value.range } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  for (const r of new DbRevisionStore(db, bookmarkAdapter).allRecords()) {
    if (!r.active || moduleShardName(db, r.target) !== mod) continue;
    bookmarks.push({ target: r.target, ...(r.value.label !== undefined ? { label: r.value.label } : {}), rid: r.rid, ts: r.ts, prov: r.prov });
  }
  return {
    shard: `annotations/${mod}`,
    module: mod,
    tags: [...tags].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
    comments: [...comments].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
    bookmarks: [...bookmarks].sort(byTargetRid as (a: Record<string, unknown>, b: Record<string, unknown>) => number),
  };
}

export function writeAnnotationsShard(db: DatabaseSync, analysisDir: string, binding: StateBinding, mod: string, result: { written: string[]; unchanged: string[] }): { shardId: string; hash: string } {
  const shardId = `annotations/${mod}`;
  const hash = writeShard(join(analysisDir, "annotations", `${mod}.json`), annotationsShardContent(db, mod), binding, result);
  return { shardId, hash };
}

/** Writes the `findings/<id>.json` shard for the CURRENTLY ACTIVE finding
 *  record whose rid is `rid` — a no-op (returns `null`) if `rid` is not the
 *  live head of its slot (e.g. it has since been superseded), matching the
 *  bulk pass's own `if (!r.active) continue` skip.
 *
 *  `record`, when passed, IS the finding record for `rid` (already in the
 *  caller's hand from its own `allRecords()` iteration) and is used as-is,
 *  skipping the re-scan of every finding revision that a fresh
 *  `new DbRevisionStore(db, findingAdapter).allRecords().find(...)` would
 *  otherwise do on every single call. A caller that only has the bare
 *  `rid` (no record in hand) may omit it; the scan then happens exactly as
 *  before. See docs/BUGS.md ("writeFindingShardForRid re-scans all
 *  records per call"). */
export function writeFindingShardForRid(db: DatabaseSync, analysisDir: string, binding: StateBinding, rid: number, result: { written: string[]; unchanged: string[] }, record?: DbRevision<FindingValue>): { shardId: string; hash: string } | null {
  const r = record ?? new DbRevisionStore(db, findingAdapter).allRecords().find((rec) => Number(rec.rid) === rid);
  if (r === undefined || Number(r.rid) !== rid || !r.active) return null;
  const id = findingContentId(r.target, r.value.evidence);
  const shardId = `findings/${id}`;
  const hash = writeShard(
    join(analysisDir, "findings", `${id}.json`),
    { shard: shardId, id, target: r.target, kind: "finding", findingNo: r.value.findingNo, severity: r.value.severity, status: r.value.status, claim: r.value.claim, evidence: r.value.evidence, rid: r.rid, ts: r.ts, prov: r.prov },
    binding,
    result,
  );
  return { shardId, hash };
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
  // simplification" — still true for the SHARD-hash-of-current-state field;
  // `value`, added below, closes the actual history-recovery gap instead).
  const shardHash = new Map<string, string>();

  // --- names, one file per module -------------------------------------
  const modulesWithNames = new Set<string>();
  for (const r of new DbRevisionStore(db, nameAdapter).allRecords()) {
    if (r.active) modulesWithNames.add(moduleShardName(db, r.target));
  }
  for (const mod of [...modulesWithNames].sort()) {
    const w = writeNamesShard(db, analysisDir, binding, mod, result);
    shardHash.set(w.shardId, w.hash);
  }

  // --- annotations (tags/comments/bookmarks), one file per module -----
  const modulesWithAnn = new Set<string>();
  for (const r of new DbRevisionStore(db, tagAdapter).allRecords()) {
    if (r.active) modulesWithAnn.add(moduleShardName(db, r.target));
  }
  for (const r of new DbRevisionStore(db, commentAdapter).allRecords()) {
    if (r.active) modulesWithAnn.add(moduleShardName(db, r.target));
  }
  for (const r of new DbRevisionStore(db, bookmarkAdapter).allRecords()) {
    if (r.active) modulesWithAnn.add(moduleShardName(db, r.target));
  }
  for (const mod of [...modulesWithAnn].sort()) {
    const w = writeAnnotationsShard(db, analysisDir, binding, mod, result);
    shardHash.set(w.shardId, w.hash);
  }

  // --- findings, one file per content-hash id --------------------------
  const findingShardOf = new Map<string, string>(); // rid -> shard id, for the log pass
  for (const r of new DbRevisionStore(db, findingAdapter).allRecords()) {
    const id = findingContentId(r.target, r.value.evidence);
    findingShardOf.set(r.rid, `findings/${id}`);
    if (!r.active) continue;
    const w = writeFindingShardForRid(db, analysisDir, binding, Number(r.rid), result, r);
    if (w !== null) shardHash.set(w.shardId, w.hash);
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
  readonly slot: string;
  readonly reactivates: number | null;
}

/** Reads back the value a content-bearing (`op='annotate'`) row minted, by
 *  `rid` — works for a superseded row exactly as well as the currently
 *  active one, since `revisions`/`d_*` rows are immutable (never updated or
 *  deleted, schema.sql §2.5's append-only triggers). This is what closes
 *  the step-0 "known simplification": a `log/` entry now carries the WRITE'S
 *  OWN value, not just a reference to whatever the shard currently holds, so
 *  `rebuild.ts` can reconstruct a superseded record's real content instead
 *  of an inert placeholder (§R4 step 2). */
function readWrittenValue(db: DatabaseSync, kind: string, rid: number): unknown {
  const adapter = (detailAdapters as Record<string, { readDetail(db: DatabaseSync, rid: number): unknown }>)[kind];
  return adapter?.readDetail(db, rid);
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
    const revRow = db.prepare(`SELECT target, kind, slot, reactivates FROM revisions WHERE rid = ?`).get(row.rid) as unknown as RevTargetRow | undefined;
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
    const value = revRow !== undefined && row.op === "annotate" ? readWrittenValue(db, revRow.kind, row.rid) : undefined;
    const entry = {
      seq: row.rid,
      ts: row.ts,
      op: row.op,
      actor: { source: row.actor_source, who: row.actor_who, ...(row.actor_run !== null ? { run: row.actor_run } : {}) },
      ...(revRow !== undefined ? { kind: revRow.kind, target: revRow.target, slot: revRow.slot } : {}),
      rid: String(row.rid),
      shards,
      ...(value !== undefined ? { value } : {}),
      ...(revRow !== undefined && row.op === "revert" ? { reactivates: revRow.reactivates === null ? null : String(revRow.reactivates) } : {}),
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

// ===========================================================================
// Write-path export (§6 step 3 / §R4 step 2): one hook, called right after
// EACH `DbRevisionStore.set`/`.revert` commits (`ProjectService`'s DB write
// verbs, `src/project/service.ts`), instead of only the one-shot bulk
// `exportProject` above. Materialises just the ONE shard the write touched
// (`writeNamesShard`/`writeAnnotationsShard`/`writeFindingShardForRid`, the
// SAME functions the bulk pass uses — guarantees byte-identical shard
// content either way) and appends exactly ONE chained `log/` entry for that
// write, carrying the write's own value (`readWrittenValue`) so a later
// `rebuild` can reconstruct a superseded/reverted-from record's real
// content, not the step-0 inert placeholder.
// ===========================================================================

/** The last entry's `hash` across every `log/*.jsonl` file (day files sort
 *  lexicographically, chain is append-order within a file — same walk
 *  `verify.ts`'s `checkLogChain` does) — the chain's current tip, or
 *  `"genesis"` for an empty/absent log dir. */
function tipHash(logDir: string): string {
  if (!existsSync(logDir)) return "genesis";
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const lines = readFileSync(join(logDir, files[i]!), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const last = lines[lines.length - 1];
    if (last !== undefined) {
      const parsed = JSON.parse(last) as { hash?: unknown };
      if (typeof parsed.hash === "string") return parsed.hash;
    }
  }
  return "genesis";
}

/** Appends one hash-chained entry (§5) to `log/<date>.jsonl` (creating it if
 *  today's file doesn't exist yet), chaining from the CURRENT tip
 *  (`tipHash`) — the true per-write counterpart of the bulk `exportLog`
 *  pass's from-genesis recompute. `partial` is the entry minus `prevHash`/
 *  `hash`, which this function computes and adds. */
function appendLogEntry(logDir: string, partial: Record<string, unknown>, result: { written: string[]; unchanged: string[] }): { path: string; hash: string } {
  const prevHash = tipHash(logDir);
  const withPrev = { ...partial, prevHash };
  const hash = sha256Hex(canonicalJson(withPrev));
  const full = { ...withPrev, hash };
  const day = dayOf(String(partial.ts));
  const path = join(logDir, `${day}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, `${prior}${canonicalJson(full)}\n`, "utf8");
  result.written.push(path);
  return { path, hash };
}

export interface WriteEffect {
  /** The shard(s) this ONE write's log entry records — empty for a `revert`
   *  that cleared a slot to nothing (no live shard left to point at), same
   *  as the bulk pass's own "no live shard" case. */
  readonly shards: readonly { path: string; contentHash: string }[];
  readonly logPath: string;
}

/** The write-path hook: given the `rid` `DbRevisionStore.set`/`.revert` just
 *  minted (already committed — this function only reads `db`, never writes
 *  it), materialises the ONE affected shard and appends ONE chained `log/`
 *  entry for it. Call this immediately after each DB-backed write verb
 *  (`src/project/service.ts`), the moment its own transaction has committed
 *  — mirrors §6 step 3's "commit to `cache.db`, then export the affected
 *  shard(s) + append to the log" in the SAME granularity as the write
 *  itself, not batched. Idempotent to call twice for the SAME rid is NOT
 *  guaranteed (the log append is not itself hash-locked/no-op like a shard
 *  write) — callers must call it exactly once per write, which is what
 *  every write verb below does. */
export function exportWriteEffect(db: DatabaseSync, projectDir: string, rid: number): WriteEffect {
  const analysisDir = join(projectDir, "analysis");
  const logDir = join(projectDir, "log");
  mkdirSync(analysisDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const binding = stateBindingOf(db);
  const result = { written: [] as string[], unchanged: [] as string[] };

  const logRow = db.prepare(`SELECT rid, ts, op, actor_source, actor_who, actor_run FROM log WHERE rid = ?`).get(rid) as
    | { rid: number; ts: string; op: string; actor_source: string; actor_who: string; actor_run: string | null }
    | undefined;
  if (logRow === undefined) throw new Error(`exportWriteEffect: no log row for rid ${rid} — call this only right after a DB write committed`);
  const revRow = db.prepare(`SELECT kind, target, slot, reactivates FROM revisions WHERE rid = ?`).get(rid) as unknown as RevTargetRow | undefined;
  if (revRow === undefined) throw new Error(`exportWriteEffect: no revisions row for rid ${rid}`);

  const shards: { path: string; contentHash: string }[] = [];
  let value: unknown;
  if (logRow.op === "annotate") {
    value = readWrittenValue(db, revRow.kind, rid);
    if (revRow.kind === "name") {
      const w = writeNamesShard(db, analysisDir, binding, moduleShardName(db, revRow.target), result);
      shards.push({ path: w.shardId, contentHash: w.hash });
    } else if (revRow.kind === "tag" || revRow.kind === "comment" || revRow.kind === "bookmark") {
      const w = writeAnnotationsShard(db, analysisDir, binding, moduleShardName(db, revRow.target), result);
      shards.push({ path: w.shardId, contentHash: w.hash });
    } else if (revRow.kind === "finding") {
      const w = writeFindingShardForRid(db, analysisDir, binding, rid, result);
      if (w !== null) shards.push({ path: w.shardId, contentHash: w.hash });
    }
  } else if (logRow.op === "revert") {
    // A revert that reactivated a PRIOR record makes that prior rid's slot
    // live again — the shard it belongs to needs re-materialising too (it
    // may have been dropped from the shard on the superseding write and
    // must reappear now). A revert-to-nothing (reactivates === null)
    // clears the slot; the shard write below simply omits it (same "only
    // active state" rule every shard write follows) — `shards` stays empty,
    // matching the bulk pass's "no live shard" case.
    if (revRow.kind === "name") {
      const w = writeNamesShard(db, analysisDir, binding, moduleShardName(db, revRow.target), result);
      shards.push({ path: w.shardId, contentHash: w.hash });
    } else if (revRow.kind === "tag" || revRow.kind === "comment" || revRow.kind === "bookmark") {
      const w = writeAnnotationsShard(db, analysisDir, binding, moduleShardName(db, revRow.target), result);
      shards.push({ path: w.shardId, contentHash: w.hash });
    } else if (revRow.kind === "finding" && revRow.reactivates !== null) {
      const w = writeFindingShardForRid(db, analysisDir, binding, revRow.reactivates, result);
      if (w !== null) shards.push({ path: w.shardId, contentHash: w.hash });
    }
  }

  const { path: logPath } = appendLogEntry(
    logDir,
    {
      seq: rid,
      ts: logRow.ts,
      op: logRow.op,
      actor: { source: logRow.actor_source, who: logRow.actor_who, ...(logRow.actor_run !== null ? { run: logRow.actor_run } : {}) },
      kind: revRow.kind,
      target: revRow.target,
      slot: revRow.slot,
      rid: String(rid),
      shards,
      ...(value !== undefined ? { value } : {}),
      ...(logRow.op === "revert" ? { reactivates: revRow.reactivates === null ? null : String(revRow.reactivates) } : {}),
    },
    result,
  );

  return { shards, logPath };
}
