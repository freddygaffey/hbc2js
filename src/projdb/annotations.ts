// src/projdb/annotations.ts — the annotation write verbs (docs/specs/16-
// project-db.md §2.3, §8 step 3), wiring names/comments/tags/bookmarks/
// findings onto `DbRevisionStore` (`revision-store.ts`). Same division of
// labour as the JSONL engine's per-kind wrappers (`src/project/tags.ts`,
// `comments.ts`, `bookmarks.ts`, `findings.ts`): the generic engine treats
// `target` as an opaque slot key; each verb here composes that key from the
// record's real target plus whatever extra discriminator its kind needs
// (a tag name, a comment's range, a finding's `patternId`) — mirroring
// `TagStore`'s `slotKey(target, tag)` exactly, just against SQLite instead
// of an in-memory array.
import type { DatabaseSync } from "node:sqlite";
import { DbRevisionStore } from "./revision-store.ts";
import type { DbCtxSnapshot, DbProvenance, DbRevision, DbRevisionSetResult, DetailAdapter } from "./revision-store.ts";

// --- name -------------------------------------------------------------------

export interface NameValue {
  readonly name: string;
}

const nameAdapter: DetailAdapter<NameValue> = {
  kind: "name",
  writeDetail(db, rid, value) {
    db.prepare(`INSERT INTO d_names (rid, name) VALUES (?, ?)`).run(rid, value.name);
  },
  readDetail(db, rid) {
    const row = db.prepare(`SELECT name FROM d_names WHERE rid = ?`).get(rid) as unknown as { name: string };
    return { name: row.name };
  },
};

function nameSlot(target: string): string {
  return `name:${target}`;
}

export function dbSetName(db: DatabaseSync, target: string, name: string, prov: DbProvenance, opts?: { readonly ts?: string; readonly ctx?: DbCtxSnapshot }): DbRevisionSetResult<NameValue> {
  const store = new DbRevisionStore(db, nameAdapter);
  return store.set(nameSlot(target), target, { name }, prov, opts);
}

export function dbGetName(db: DatabaseSync, target: string): DbRevision<NameValue> | undefined {
  return new DbRevisionStore(db, nameAdapter).get(nameSlot(target));
}

export function dbRevertName(db: DatabaseSync, target: string, prov: DbProvenance, toTs?: string): DbRevision<NameValue> | null {
  return new DbRevisionStore(db, nameAdapter).revert(nameSlot(target), prov, toTs);
}

// --- comment ------------------------------------------------------------

export interface CommentRangeValue {
  readonly line: number;
  readonly col?: number;
}

export interface CommentValue {
  readonly body: string;
  readonly range?: CommentRangeValue;
}

const commentAdapter: DetailAdapter<CommentValue> = {
  kind: "comment",
  writeDetail(db, rid, value) {
    db.prepare(`INSERT INTO d_comments (rid, body, range_line, range_col) VALUES (?, ?, ?, ?)`).run(
      rid,
      value.body,
      value.range?.line ?? null,
      value.range?.col ?? null,
    );
  },
  readDetail(db, rid) {
    const row = db.prepare(`SELECT body, range_line, range_col FROM d_comments WHERE rid = ?`).get(rid) as unknown as {
      body: string;
      range_line: number | null;
      range_col: number | null;
    };
    return {
      body: row.body,
      ...(row.range_line !== null ? { range: { line: row.range_line, ...(row.range_col !== null ? { col: row.range_col } : {}) } } : {}),
    };
  },
};

function commentSlot(target: string, range: CommentRangeValue | undefined): string {
  if (range === undefined) return `comment:${target}`;
  return range.col !== undefined ? `comment:${target}:${range.line}:${range.col}` : `comment:${target}:${range.line}`;
}

export function dbAddComment(
  db: DatabaseSync,
  target: string,
  body: string,
  prov: DbProvenance,
  opts?: { readonly range?: CommentRangeValue; readonly ts?: string; readonly ctx?: DbCtxSnapshot },
): DbRevisionSetResult<CommentValue> {
  const store = new DbRevisionStore(db, commentAdapter);
  return store.set(commentSlot(target, opts?.range), target, { body, ...(opts?.range ? { range: opts.range } : {}) }, prov, opts);
}

export function dbRevertComment(db: DatabaseSync, target: string, prov: DbProvenance, opts?: { readonly range?: CommentRangeValue; readonly toTs?: string }): DbRevision<CommentValue> | null {
  return new DbRevisionStore(db, commentAdapter).revert(commentSlot(target, opts?.range), prov, opts?.toTs);
}

export function dbGetComment(db: DatabaseSync, target: string, range?: CommentRangeValue): DbRevision<CommentValue> | undefined {
  return new DbRevisionStore(db, commentAdapter).get(commentSlot(target, range));
}

export function dbCommentHistory(db: DatabaseSync, target: string, range?: CommentRangeValue): readonly DbRevision<CommentValue>[] {
  return new DbRevisionStore(db, commentAdapter).history(commentSlot(target, range));
}

// --- tag ------------------------------------------------------------------

export interface TagValue {
  readonly tag: string;
  readonly note?: string;
}

const tagAdapter: DetailAdapter<TagValue> = {
  kind: "tag",
  writeDetail(db, rid, value) {
    db.prepare(`INSERT INTO d_tags (rid, tag, note) VALUES (?, ?, ?)`).run(rid, value.tag, value.note ?? null);
  },
  readDetail(db, rid) {
    const row = db.prepare(`SELECT tag, note FROM d_tags WHERE rid = ?`).get(rid) as unknown as { tag: string; note: string | null };
    return { tag: row.tag, ...(row.note !== null ? { note: row.note } : {}) };
  },
};

function tagSlot(target: string, tag: string): string {
  return `tag:${target}:${tag}`;
}

export function dbSetTag(
  db: DatabaseSync,
  target: string,
  tag: string,
  prov: DbProvenance,
  opts?: { readonly note?: string; readonly ts?: string; readonly ctx?: DbCtxSnapshot },
): DbRevisionSetResult<TagValue> {
  const store = new DbRevisionStore(db, tagAdapter);
  return store.set(tagSlot(target, tag), target, { tag, ...(opts?.note !== undefined ? { note: opts.note } : {}) }, prov, opts);
}

export function dbGetTags(db: DatabaseSync, target: string): readonly DbRevision<TagValue>[] {
  const rows = db.prepare(`SELECT DISTINCT slot FROM revisions WHERE kind = 'tag' AND target = ?`).all(target) as unknown as { slot: string }[];
  const store = new DbRevisionStore(db, tagAdapter);
  const out: DbRevision<TagValue>[] = [];
  for (const { slot } of rows) {
    const active = store.get(slot);
    if (active !== undefined) out.push(active);
  }
  return out;
}

export function dbRevertTag(db: DatabaseSync, target: string, tag: string, prov: DbProvenance, toTs?: string): DbRevision<TagValue> | null {
  return new DbRevisionStore(db, tagAdapter).revert(tagSlot(target, tag), prov, toTs);
}

// --- bookmark ---------------------------------------------------------------

export interface BookmarkValue {
  readonly label?: string;
}

const bookmarkAdapter: DetailAdapter<BookmarkValue> = {
  kind: "bookmark",
  writeDetail(db, rid, value) {
    db.prepare(`INSERT INTO d_bookmarks (rid, label) VALUES (?, ?)`).run(rid, value.label ?? null);
  },
  readDetail(db, rid) {
    const row = db.prepare(`SELECT label FROM d_bookmarks WHERE rid = ?`).get(rid) as unknown as { label: string | null };
    return row.label !== null ? { label: row.label } : {};
  },
};

function bookmarkSlot(target: string): string {
  return `bookmark:${target}`;
}

export function dbSetBookmark(db: DatabaseSync, target: string, prov: DbProvenance, opts?: { readonly label?: string; readonly ts?: string; readonly ctx?: DbCtxSnapshot }): DbRevisionSetResult<BookmarkValue> {
  const store = new DbRevisionStore(db, bookmarkAdapter);
  return store.set(bookmarkSlot(target), target, opts?.label !== undefined ? { label: opts.label } : {}, prov, opts);
}

export function dbRevertBookmark(db: DatabaseSync, target: string, prov: DbProvenance, toTs?: string): DbRevision<BookmarkValue> | null {
  return new DbRevisionStore(db, bookmarkAdapter).revert(bookmarkSlot(target), prov, toTs);
}

// --- finding ----------------------------------------------------------------

export interface FindingEvidenceValue {
  readonly ref: string;
  readonly role: string;
}

export interface FindingValue {
  readonly findingNo: number;
  readonly severity: string;
  readonly status: string;
  readonly claim: string;
  readonly evidence: readonly FindingEvidenceValue[];
}

const findingAdapter: DetailAdapter<FindingValue> = {
  kind: "finding",
  writeDetail(db, rid, value) {
    db.prepare(`INSERT INTO d_findings (rid, finding_no, severity, status, claim) VALUES (?, ?, ?, ?, ?)`).run(
      rid,
      value.findingNo,
      value.severity,
      value.status,
      value.claim,
    );
    const ins = db.prepare(`INSERT INTO d_evidence (rid, ord, ref, role) VALUES (?, ?, ?, ?)`);
    value.evidence.forEach((e, i) => ins.run(rid, i, e.ref, e.role));
  },
  readDetail(db, rid) {
    const row = db.prepare(`SELECT finding_no, severity, status, claim FROM d_findings WHERE rid = ?`).get(rid) as unknown as {
      finding_no: number;
      severity: string;
      status: string;
      claim: string;
    };
    const evidence = db.prepare(`SELECT ref, role FROM d_evidence WHERE rid = ? ORDER BY ord`).all(rid) as unknown as FindingEvidenceValue[];
    return { findingNo: row.finding_no, severity: row.severity, status: row.status, claim: row.claim, evidence };
  },
};

function findingSlot(target: string, patternId?: string): string {
  return patternId !== undefined ? `finding:${target}:${patternId}` : `finding:${target}`;
}

export function dbSetFinding(
  db: DatabaseSync,
  target: string,
  value: FindingValue,
  prov: DbProvenance,
  opts?: { readonly patternId?: string; readonly ts?: string; readonly ctx?: DbCtxSnapshot },
): DbRevisionSetResult<FindingValue> {
  const store = new DbRevisionStore(db, findingAdapter);
  return store.set(findingSlot(target, opts?.patternId), target, value, prov, opts);
}

export function dbRevertFinding(db: DatabaseSync, target: string, prov: DbProvenance, opts?: { readonly patternId?: string; readonly toTs?: string }): DbRevision<FindingValue> | null {
  return new DbRevisionStore(db, findingAdapter).revert(findingSlot(target, opts?.patternId), prov, opts?.toTs);
}
