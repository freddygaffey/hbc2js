// src/projdb/project-read.ts — §8 step 4 (docs/specs/16-project-db.md §3.2):
// the DB-backed read path for `ProjectService`. Builds the exact
// `ProjectStore` shape `src/project/io.ts`'s `loadProjectStore` returns
// (`src/project/service.ts`'s `applyStore` is the ONE place that shape is
// consumed, and it does not care which backend produced it) from
// `DbRevisionStore.allRecords()` over the tag/comment/bookmark/finding
// adapters `src/projdb/annotations.ts` already defines — reusing step 3's
// engine rather than re-querying `revisions`/`d_*` directly (§8 step 4's
// "reuse: both services' verb layer + caps").
//
// Known scope gaps (not fixed here — schema.sql is step 3's, out of this
// round's file list): `revisions.kind='status'` (finding status-transition
// rows) has no `d_status` detail table, so `StatusRecord`s are not
// reconstructed; `revisions.kind='conflict'` has no `v_json_conflicts`
// analogue either, matching §9/§10's own merge-deferral ruling (conflict
// records are minted only by `project merge`, deferred for DB projects).
// Both are recorded as a `docs/BUGS.md` row (CLAUDE.md's "no fixture without
// a BUGS.md row" rule, extended here to this scope gap) rather than left
// silently unimplemented.
import type { DatabaseSync } from "node:sqlite";
import { DbRevisionStore } from "./revision-store.ts";
import { bookmarkAdapter, commentAdapter, findingAdapter, tagAdapter } from "./annotations.ts";
import type { ProjectStore } from "../project/io.ts";
import { PROJECT_SCHEMA } from "../project/schema.ts";
import type { BookmarkRecord, CommentRecord, CtxSnapshot, EvidenceRef, FindingRecord, Provenance, Tag, TagRecord } from "../project/schema.ts";

function toProv(p: { readonly source: "human" | "llm" | "tool"; readonly who: string; readonly run?: string | null }): Provenance {
  return { source: p.source, who: p.who, ...(p.run !== undefined && p.run !== null ? { run: p.run } : {}) };
}

function toCtx(c: { readonly name?: string | null; readonly loc?: string | null; readonly ownerFn?: string | null }): CtxSnapshot {
  return {
    ...(c.name !== undefined && c.name !== null ? { name: c.name } : {}),
    ...(c.loc !== undefined && c.loc !== null ? { loc: c.loc } : {}),
    ...(c.ownerFn !== undefined && c.ownerFn !== null ? { ownerFn: c.ownerFn } : {}),
  };
}

/** Builds a `ProjectStore` for `storeDir` from an open project DB — the DB
 *  counterpart of `src/project/io.ts`'s `loadProjectStore`. `conflicts`/
 *  `status` rows are not reconstructed (module header). */
export function loadProjectStoreFromDb(db: DatabaseSync, storeDir: string, bundleSha256: string): ProjectStore {
  const tags: TagRecord[] = new DbRevisionStore(db, tagAdapter).allRecords().map((r) => ({
    rid: r.rid,
    kind: "tag",
    target: r.target,
    prov: toProv(r.prov),
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx: toCtx(r.ctx),
    tag: r.value.tag as Tag,
    ...(r.value.note !== undefined ? { note: r.value.note } : {}),
  }));

  const comments: CommentRecord[] = new DbRevisionStore(db, commentAdapter).allRecords().map((r) => ({
    rid: r.rid,
    kind: "comment",
    target: r.target,
    prov: toProv(r.prov),
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx: toCtx(r.ctx),
    body: r.value.body,
    ...(r.value.range !== undefined ? { range: r.value.range } : {}),
  }));

  const bookmarks: BookmarkRecord[] = new DbRevisionStore(db, bookmarkAdapter).allRecords().map((r) => ({
    rid: r.rid,
    kind: "bookmark",
    target: r.target,
    prov: toProv(r.prov),
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx: toCtx(r.ctx),
    ...(r.value.label !== undefined ? { label: r.value.label } : {}),
  }));

  const findings: FindingRecord[] = new DbRevisionStore(db, findingAdapter).allRecords().map((r) => ({
    rid: r.rid,
    kind: "finding",
    target: r.target,
    prov: toProv(r.prov),
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx: toCtx(r.ctx),
    claim: r.value.claim,
    severity: r.value.severity as FindingRecord["severity"],
    status: r.value.status as FindingRecord["status"],
    evidence: r.value.evidence.map((e): EvidenceRef => ({ ref: e.ref, role: e.role })),
  }));

  return {
    dir: storeDir,
    header: { schema: PROJECT_SCHEMA, kind: "header", seq: { comments: comments.length, tags: tags.length, bookmarks: bookmarks.length, findings: findings.length }, builtFor: { bundleSha256 } },
    comments,
    tags,
    bookmarks,
    findings,
  };
}
