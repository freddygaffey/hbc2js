// `project merge` — docs/specs/11-project-store.md §2.3, §7 step 7.
//
// A pure function over two loaded `ProjectStore`s (no I/O of its own — the
// CLI/service loads both sides via `io.ts` and persists the result the same
// way any other write does). Per file (comments/tags/bookmarks/findings):
//
//   1. REFUSE unless both stores' `builtFor.bundleSha256` match (§2.3,
//      reviewer ruling 4) — checked once, by the caller, before this module
//      is even invoked (see `service.ts#mergeFrom`); `mergeStores` re-checks
//      defensively so it is never safe to call past that guard by accident.
//   2. LINE UNION: every row from both sides. A literal duplicate (same
//      `rid`, byte-identical content) counts once. A `rid` COLLISION (same
//      `rid`, different content — two independent stores mint `rid`s from
//      their own local counters, §2.1's "store-local monotonic id", so this
//      is expected, not corruption) is resolved by deterministically
//      renaming the incoming (`other`) store's copy and every `supersedes`
//      pointer within `other` that referenced it — never by dropping either
//      side.
//   3. SLOT CONFLICT: per record-type slot key (mirrors each module's own
//      key: `target` for bookmarks, `target range` for comments, `target
//      tag` for tags, `target patternId` for a patterned finding — an
//      ordinary finding has no natural slot, §7 step 4's default mints a
//      fresh one per `addFinding`, so it never collides), if the union now
//      has ≥2 DISTINCT active records for one slot AND they came from BOTH
//      sides (a same-slot double-supersede, §2.3), mint one `conflict`
//      record referencing every such rid. Neither side's record is dropped,
//      demoted or silently preferred — the conflict record is additive.
//
// Both original rows survive untouched (no `active` flag is ever flipped by
// a merge) — "the merge keeps BOTH new records" (§2.3) is implemented
// literally, not by picking a winner and noting the loser.
import type {
  BookmarkRecord,
  CommentRecord,
  ConflictRecord,
  FindingRecord,
  ProjectHeader,
  Provenance,
  StatusRecord,
  TagRecord,
} from "./schema.ts";
import { assertSameBuiltFor, compareRows } from "./schema.ts";
import type { ProjectStore } from "./io.ts";

const MERGE_PROV: Provenance = { source: "tool", who: "project-merge" };

interface EnvelopeLike {
  readonly rid: string;
  readonly kind: string;
  readonly target: string;
  readonly active: boolean;
  readonly supersedes: string | null;
}

export interface MergeFileResult<T extends EnvelopeLike> {
  readonly rows: readonly T[];
  readonly conflicts: readonly ConflictRecord[];
}

/** Tiny deterministic (djb2) string hash, hex-encoded — not cryptographic,
 *  just a stable content fingerprint so a collision rename is a pure
 *  function of the COLLIDING ROW'S OWN CONTENT, not of merge order or of
 *  what else happens to already be in `self`. That purity is what makes
 *  re-running a merge against an UNCHANGED `other` store idempotent: the
 *  renamed rid comes out identical both times, so the second run's rid+
 *  content dedup (`unionRows`) recognises it as already-merged instead of
 *  minting a fresh rid (and, downstream, a duplicate conflict record). */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** Rename every colliding `other` rid (and any `supersedes` pointer to it,
 *  within `other` itself) to `<rid>~<contentHash>` — deterministic given
 *  the row's own content, so re-running the merge against an unchanged
 *  `other` reproduces the SAME renamed rid (idempotency; A-CONFLICT's
 *  determinism row). Returns `other`'s rows with `rid`/`supersedes`
 *  remapped; `self`'s rows are untouched. */
function remapCollisions<T extends EnvelopeLike>(selfRows: readonly T[], otherRows: readonly T[]): readonly T[] {
  const selfByRid = new Map(selfRows.map((r) => [r.rid, r] as const));
  const remap = new Map<string, string>();
  for (const row of otherRows) {
    const clash = selfByRid.get(row.rid);
    if (clash === undefined) continue;
    if (JSON.stringify(clash) === JSON.stringify(row)) continue; // true duplicate, no rename needed
    remap.set(row.rid, `${row.rid}~${fingerprint(JSON.stringify(row))}`);
  }
  if (remap.size === 0) return otherRows;
  return otherRows.map((row) => ({
    ...row,
    rid: remap.get(row.rid) ?? row.rid,
    supersedes: row.supersedes !== null ? (remap.get(row.supersedes) ?? row.supersedes) : null,
  }));
}

/** Union two sides' rows for one file, dropping exact (rid+content)
 *  duplicates, keeping every other row from both sides untouched. */
function unionRows<T extends EnvelopeLike>(selfRows: readonly T[], otherRemapped: readonly T[]): readonly T[] {
  const seen = new Map<string, T>();
  for (const row of selfRows) seen.set(row.rid, row);
  const merged: T[] = [...selfRows];
  for (const row of otherRemapped) {
    const existing = seen.get(row.rid);
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(row)) continue; // duplicate
    merged.push(row);
    seen.set(row.rid, row);
  }
  return merged;
}

/** Mint conflict records for slots with ≥2 distinct active rids spanning
 *  both `self` and `other` origins. `slotKey` returns `null` for a row that
 *  has no natural supersession slot (an ordinary, patternId-less finding) —
 *  such rows can never conflict and are skipped. */
function detectConflicts<T extends EnvelopeLike>(
  merged: readonly T[],
  originOf: (rid: string) => "self" | "other" | "new",
  slotKey: (row: T) => string | null,
  conflictKindPredicate: (row: T) => boolean,
  now: () => string,
): readonly ConflictRecord[] {
  const bySlot = new Map<string, T[]>();
  for (const row of merged) {
    if (!conflictKindPredicate(row) || !row.active) continue;
    const key = slotKey(row);
    if (key === null) continue;
    const bucket = bySlot.get(key) ?? [];
    bucket.push(row);
    bySlot.set(key, bucket);
  }
  const conflicts: ConflictRecord[] = [];
  // Start past any `conflict` rows already in the union (minted by an
  // EARLIER merge into this same store) so a later merge's new conflict
  // rids never collide with them.
  let n = merged.filter((r) => r.kind === "conflict").length;
  for (const [, rows] of bySlot) {
    if (rows.length < 2) continue;
    const origins = new Set(rows.map((r) => originOf(r.rid)));
    if (!(origins.has("self") && origins.has("other"))) continue; // pre-existing multi-active, not a merge artifact
    const rids = rows.map((r) => r.rid).sort();
    conflicts.push({
      rid: `c${n++}`,
      kind: "conflict",
      target: rows[0]!.target,
      prov: MERGE_PROV,
      ts: now(),
      supersedes: null,
      active: true,
      ctx: {},
      rids,
    });
  }
  return conflicts;
}

function mergeFile<T extends EnvelopeLike>(
  selfRows: readonly T[],
  otherRows: readonly T[],
  slotKey: (row: T) => string | null,
  conflictKindPredicate: (row: T) => boolean,
  now: () => string,
): MergeFileResult<T> {
  const otherRemapped = remapCollisions(selfRows, otherRows);
  const merged = unionRows(selfRows, otherRemapped);
  const selfRids = new Set(selfRows.map((r) => r.rid));
  const otherRids = new Set(otherRemapped.map((r) => r.rid));
  const originOf = (rid: string): "self" | "other" | "new" => (selfRids.has(rid) ? "self" : otherRids.has(rid) ? "other" : "new");
  const conflicts = detectConflicts(merged, originOf, slotKey, conflictKindPredicate, now);
  // `conflicts` are `ConflictRecord`s; every call site's `T` is that record
  // type's OWN file union (e.g. `TagRecord | ConflictRecord`), so this is
  // always a widening back into `T`, never a genuine type mismatch — TS just
  // can't see the relationship through the generic.
  const rows = [...merged, ...conflicts].sort(compareRows) as unknown as readonly T[];
  return { rows, conflicts };
}

const tagSlotKey = (r: TagRecord | ConflictRecord): string | null => (r.kind === "tag" ? `${r.target} ${r.tag}` : null);
const isTag = (r: TagRecord | ConflictRecord): boolean => r.kind === "tag";

function commentRangeKey(range: CommentRecord["range"]): string {
  if (range === undefined) return "";
  return range.col !== undefined ? `:${range.line}:${range.col}` : `:${range.line}`;
}
const commentSlotKey = (r: CommentRecord | ConflictRecord): string | null => (r.kind === "comment" ? `${r.target}${commentRangeKey(r.range)}` : null);
const isComment = (r: CommentRecord | ConflictRecord): boolean => r.kind === "comment";

const bookmarkSlotKey = (r: BookmarkRecord | ConflictRecord): string | null => (r.kind === "bookmark" ? r.target : null);
const isBookmark = (r: BookmarkRecord | ConflictRecord): boolean => r.kind === "bookmark";

const findingSlotKey = (r: FindingRecord | StatusRecord | ConflictRecord): string | null =>
  r.kind === "finding" && r.patternId !== undefined ? `${r.target} ${r.patternId}` : null;
const isFinding = (r: FindingRecord | StatusRecord | ConflictRecord): boolean => r.kind === "finding";

export interface MergeSummary {
  readonly store: ProjectStore;
  readonly conflictCount: number;
}

/** Merge `other` into `self`. Refuses (throws) unless both headers' `
 *  builtFor.bundleSha256` match (§2.3). Pure — callers persist `store`
 *  themselves (`ProjectService#mergeFrom` does, via the normal `save()`). */
export function mergeStores(self: ProjectStore, other: ProjectStore, now: () => string = () => new Date().toISOString()): MergeSummary {
  assertSameBuiltFor(self.header as ProjectHeader, other.header as ProjectHeader, "merge");

  const tags = mergeFile(self.tags, other.tags, tagSlotKey, isTag, now);
  const comments = mergeFile(self.comments, other.comments, commentSlotKey, isComment, now);
  const bookmarks = mergeFile(self.bookmarks, other.bookmarks, bookmarkSlotKey, isBookmark, now);
  const findings = mergeFile(self.findings, other.findings, findingSlotKey, isFinding, now);

  const conflictCount = tags.conflicts.length + comments.conflicts.length + bookmarks.conflicts.length + findings.conflicts.length;

  return {
    store: {
      dir: self.dir,
      header: {
        schema: self.header.schema,
        kind: "header",
        seq: { comments: comments.rows.length, tags: tags.rows.length, bookmarks: bookmarks.rows.length, findings: findings.rows.length },
        builtFor: self.header.builtFor,
      },
      comments: comments.rows,
      tags: tags.rows,
      bookmarks: bookmarks.rows,
      findings: findings.rows,
    },
    conflictCount,
  };
}
