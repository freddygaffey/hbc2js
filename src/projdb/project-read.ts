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
// Finding status transitions (docs/BUGS.md 2026-09-05 row, fixed here).
// `revisions.kind='status'` still has no `d_status` detail table (schema.sql
// is step 3's, out of this round's file list), so `ProjectService.
// setFindingStatus`'s DB branch records a transition as a fresh
// `kind='finding'` revision on the SAME slot carrying the new `status` and
// the transition's evidence appended. `splitFindingRevisions` below undoes
// that folding on READ: such a revision is reclassified into the synthetic
// `StatusRecord` `FindingStore` expects, and the claim revision it
// supersedes stays the live (`active`) `FindingRecord` — so a DB-backed
// project reads back exactly like a JSONL one (stable finding `rid`, live
// status from the transition chain, claim evidence and transition evidence
// kept apart), which is what `FindingStore.statusOf` needs to see.
//
// Known scope gap (not fixed here): `revisions.kind='conflict'` has no
// `v_json_conflicts` analogue, matching §9/§10's own merge-deferral ruling
// (conflict records are minted only by `project merge`, deferred for DB
// projects). Recorded as a `docs/BUGS.md` row (CLAUDE.md's "no fixture
// without a BUGS.md row" rule, extended to this scope gap) rather than left
// silently unimplemented.
import type { DatabaseSync } from "node:sqlite";
import { DbRevisionStore } from "./revision-store.ts";
import type { DbRevision } from "./revision-store.ts";
import { bookmarkAdapter, commentAdapter, findingAdapter, tagAdapter } from "./annotations.ts";
import type { FindingEvidenceValue, FindingValue } from "./annotations.ts";
import type { ProjectStore } from "../project/io.ts";
import { PROJECT_SCHEMA } from "../project/schema.ts";
import type { BookmarkRecord, CommentRecord, CtxSnapshot, EvidenceRef, FindingRecord, FindingStatus, Provenance, StatusRecord, Tag, TagRecord } from "../project/schema.ts";

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

type FindingRevision = DbRevision<FindingValue>;

function toEvidence(e: FindingEvidenceValue): EvidenceRef {
  return { ref: e.ref, role: e.role };
}

/** Is `cur` a STATUS TRANSITION of the revision it supersedes, rather than a
 *  revised claim? Exactly the write signature `ProjectService.
 *  setFindingStatus`'s DB branch leaves behind: same `findingNo`, same claim,
 *  same severity, a DIFFERENT status, and the prior revision's evidence kept
 *  as a prefix with the transition's own refs appended. A re-emitted claim
 *  (`addFinding` on the same slot, e.g. spec 12's `patternId` producers)
 *  always mints `status:"open"` with its OWN evidence list, so it fails both
 *  the status-differs test (open->open) and the evidence-prefix test. */
function isStatusTransition(prev: FindingRevision, cur: FindingRevision): boolean {
  if (cur.value.status === prev.value.status) return false;
  if (cur.value.findingNo !== prev.value.findingNo) return false;
  if (cur.value.claim !== prev.value.claim || cur.value.severity !== prev.value.severity) return false;
  if (cur.value.evidence.length < prev.value.evidence.length) return false;
  return prev.value.evidence.every((e, i) => {
    const c = cur.value.evidence[i];
    return c !== undefined && c.ref === e.ref && c.role === e.role;
  });
}

/** Splits one `kind='finding'` supersession chain per slot back into the two
 *  JSONL record kinds `FindingStore` is built around (spec 11 §1.5): the
 *  claim rows (`finding`) and the append-only transition rows (`status`).
 *  `allRecords()` returns payload rows only (revert bookkeeping rows are
 *  filtered out there) in ascending `rid` order, so a revision's predecessor
 *  — `supersedes`, which also identifies the chain — is always classified
 *  before it. The chain's ACTIVE row decides both: its claim row (itself, or
 *  the claim its transition chain hangs off) is the live `FindingRecord`, and
 *  it is the live `StatusRecord` when it is a transition — so a revert to an
 *  earlier row correctly takes the later status back with it. */
function splitFindingRevisions(revs: readonly FindingRevision[]): {
  readonly findings: readonly FindingRecord[];
  readonly statuses: readonly StatusRecord[];
} {
  const byRid = new Map(revs.map((r) => [r.rid, r] as const));
  const transition = new Map<string, boolean>();
  const baseOf = new Map<string, string>(); // rid -> the claim revision this row belongs to
  const priorStatusOf = new Map<string, string | null>(); // status rid -> prior status rid on the same claim
  for (const r of revs) {
    const prev = r.supersedes !== null ? byRid.get(r.supersedes) : undefined;
    const isStatus = prev !== undefined && isStatusTransition(prev, r);
    transition.set(r.rid, isStatus);
    baseOf.set(r.rid, isStatus ? baseOf.get(prev.rid) ?? prev.rid : r.rid);
    if (isStatus) priorStatusOf.set(r.rid, transition.get(prev.rid) === true ? prev.rid : null);
  }
  const activeFindings = new Set<string>();
  const activeStatuses = new Set<string>();
  for (const r of revs) {
    if (!r.active) continue;
    activeFindings.add(baseOf.get(r.rid) ?? r.rid);
    if (transition.get(r.rid) === true) activeStatuses.add(r.rid);
  }
  const findings: FindingRecord[] = [];
  const statuses: StatusRecord[] = [];
  for (const r of revs) {
    const prev = r.supersedes !== null ? byRid.get(r.supersedes) : undefined;
    const common = { target: r.target, prov: toProv(r.prov), ts: r.ts, ctx: toCtx(r.ctx) };
    if (transition.get(r.rid) === true && prev !== undefined) {
      statuses.push({
        rid: r.rid,
        kind: "status",
        ...common,
        supersedes: priorStatusOf.get(r.rid) ?? null,
        active: activeStatuses.has(r.rid),
        finding: baseOf.get(r.rid) ?? prev.rid,
        from: prev.value.status as FindingStatus,
        to: r.value.status as FindingStatus,
        evidence: r.value.evidence.slice(prev.value.evidence.length).map(toEvidence),
      });
      continue;
    }
    findings.push({
      rid: r.rid,
      kind: "finding",
      ...common,
      supersedes: prev !== undefined ? baseOf.get(prev.rid) ?? prev.rid : null,
      active: activeFindings.has(r.rid),
      claim: r.value.claim,
      severity: r.value.severity as FindingRecord["severity"],
      status: r.value.status as FindingRecord["status"],
      evidence: r.value.evidence.map(toEvidence),
    });
  }
  return { findings, statuses };
}

/** Builds a `ProjectStore` for `storeDir` from an open project DB — the DB
 *  counterpart of `src/project/io.ts`'s `loadProjectStore`. `finding` and
 *  `status` rows both come out of the one `kind='finding'` chain
 *  (`splitFindingRevisions`); `conflict` rows are not reconstructed
 *  (module header). */
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

  const { findings, statuses } = splitFindingRevisions(new DbRevisionStore(db, findingAdapter).allRecords());

  const findingRows = [...findings, ...statuses];
  return {
    dir: storeDir,
    header: { schema: PROJECT_SCHEMA, kind: "header", seq: { comments: comments.length, tags: tags.length, bookmarks: bookmarks.length, findings: findingRows.length }, builtFor: { bundleSha256 } },
    comments,
    tags,
    bookmarks,
    findings: findingRows,
  };
}
