// The project-store on-disk schema — docs/specs/11-project-store.md §2.1/§2.2.
//
// Every record, whatever its `kind`, shares the common envelope (§2.1); each
// JSONL file is one record TYPE, headed by a schema line
// `{"schema":"hbc2js-project/1","kind":"<type>"}`; `project.json` is the
// store header (schema, per-type seq counters, `builtFor`). Pure types +
// constants here, no I/O (see `io.ts` for read/write) — same split as
// `src/name-overlay/store.ts` keeps for its own on-disk shape.

/** The store's schema string. Only the MAJOR (the number after the slash) is
 *  ever compared; an unknown major is refused, never guessed at (§2.2). */
export const PROJECT_SCHEMA_MAJOR = 1;
export const PROJECT_SCHEMA = `hbc2js-project/${PROJECT_SCHEMA_MAJOR}` as const;

/** The first line of every `project/*.jsonl` file. */
export interface SchemaHeader {
  readonly schema: string;
  readonly kind: string;
}

/** Who/what asserted a record (§4.2) — required on every record, no type is
 *  exempt, including mechanically-proposed tags (`source:"tool"`). */
export interface Provenance {
  readonly source: "human" | "llm" | "tool";
  readonly who: string;
  readonly run?: string;
}

/** The target's last-known context, snapshotted at WRITE time (§2.1, §2.5,
 *  reviewer edit E1) — never updated after the fact, it is what lets a
 *  P2.5 re-binder work from a record whose target has since gone orphaned. */
export interface CtxSnapshot {
  readonly name?: string;
  readonly loc?: string;
  readonly ownerFn?: string;
}

/** One evidence reference on a finding or a status transition (§1.5). */
export interface EvidenceRef {
  readonly ref: string;
  readonly role: string;
}

/** The §2.1 fields every record carries regardless of `kind`. Concrete record
 *  types below extend this with their own fields plus a literal `kind`. */
export interface EnvelopeBase {
  readonly rid: string;
  readonly target: string;
  readonly prov: Provenance;
  readonly ts: string;
  readonly supersedes: string | null;
  readonly active: boolean;
  readonly ctx: CtxSnapshot;
}

/** The §2.1 envelope field names, in the order used by `assertEnvelope` and
 *  by `tests/project/format-schema.test.ts` (P1c). */
export const ENVELOPE_FIELDS = ["rid", "kind", "target", "prov", "ts", "supersedes", "active", "ctx"] as const;

// --- comments.jsonl (§1.2) -------------------------------------------------

/** A site-level comment's anchor: a rendered line (from `ranges.jsonl`,
 *  spec 10 §2.7), optionally a column. */
export interface CommentRange {
  readonly line: number;
  readonly col?: number;
}

export interface CommentRecord extends EnvelopeBase {
  readonly kind: "comment";
  readonly body: string;
  readonly range?: CommentRange;
  /** Set when a site comment's `range` no longer resolves against the
   *  current render and it has re-anchored to the fn only (§9 ruling 2). */
  readonly rangeStale?: boolean;
}

// --- tags.jsonl (§1.3) ------------------------------------------------------

/** The v1 closed tag taxonomy (§1.3). Additions are a reviewed commit, same
 *  discipline as spec 10 §2.5's host-global list. */
export const TAGS = [
  "source",
  "sink",
  "sanitizer",
  "reviewed",
  "suspicious",
  "provably-dead",
  "attacker-reachable",
] as const;
export type Tag = (typeof TAGS)[number];

export interface TagRecord extends EnvelopeBase {
  readonly kind: "tag";
  readonly tag: Tag;
  readonly note?: string;
}

// --- bookmarks.jsonl (§1.4) -------------------------------------------------

export interface BookmarkRecord extends EnvelopeBase {
  readonly kind: "bookmark";
  readonly label?: string;
}

// --- findings.jsonl (§1.5) — findings AND their status transitions ---------

export type Severity = "low" | "med" | "high" | "critical";
export type FindingStatus = "open" | "confirmed" | "refuted";

export interface FindingRecord extends EnvelopeBase {
  readonly kind: "finding";
  readonly claim: string;
  readonly severity: Severity;
  readonly evidence: readonly EvidenceRef[];
  readonly status: FindingStatus;
  readonly cwe?: string;
}

/** An `open->confirmed`/`refuted` transition (§1.5) — itself an append-only
 *  record, not a mutation of the finding row. */
export interface StatusRecord extends EnvelopeBase {
  readonly kind: "status";
  readonly finding: string;
  readonly from: FindingStatus;
  readonly to: FindingStatus;
  readonly evidence: readonly EvidenceRef[];
}

export type FindingsFileRecord = FindingRecord | StatusRecord;

export type ProjectRecord = CommentRecord | TagRecord | BookmarkRecord | FindingsFileRecord;

// --- file layout (§2.2) -----------------------------------------------------

/** The four record-type files under `<artifact>/project/`, keyed by the
 *  `kind` their schema header declares. */
export type RecordFileKind = "comments" | "tags" | "bookmarks" | "findings";

export const RECORD_FILE_KINDS: readonly RecordFileKind[] = ["comments", "tags", "bookmarks", "findings"];

export const RECORD_FILE_NAMES: Record<RecordFileKind, string> = {
  comments: "comments.jsonl",
  tags: "tags.jsonl",
  bookmarks: "bookmarks.jsonl",
  findings: "findings.jsonl",
};

/** The exact directory listing P1f asserts (§2.2's file set, sorted). */
export const PROJECT_DIR_FILES = [...Object.values(RECORD_FILE_NAMES), "project.json"].sort();

// --- project.json (store header, §2.2) --------------------------------------

export interface ProjectHeaderSeq {
  readonly comments: number;
  readonly tags: number;
  readonly bookmarks: number;
  readonly findings: number;
}

export interface ProjectHeader {
  readonly schema: string;
  readonly kind: "header";
  readonly seq: ProjectHeaderSeq;
  readonly builtFor: { readonly bundleSha256: string };
}

// --- validation helpers (shared by io.ts and callers) -----------------------

/** Parse a schema header line, refusing an unknown major (§2.2's rule,
 *  verbatim from the P1b test this replaces). `expectedKind`, when given,
 *  must match the header's `kind` too. */
export function parseSchemaHeader(line: string, expectedKind?: string): SchemaHeader {
  let h: { schema?: unknown; kind?: unknown };
  try {
    h = JSON.parse(line) as { schema?: unknown; kind?: unknown };
  } catch {
    throw new Error(`malformed schema header: ${line}`);
  }
  if (typeof h.schema !== "string" || typeof h.kind !== "string") {
    throw new Error(`malformed schema header: ${line}`);
  }
  const m = /^hbc2js-project\/(\d+)$/.exec(h.schema);
  if (!m || Number(m[1]) !== PROJECT_SCHEMA_MAJOR) {
    throw new Error(`unknown project-store schema major, refusing: ${h.schema}`);
  }
  if (expectedKind !== undefined && h.kind !== expectedKind) {
    throw new Error(`schema header kind mismatch: expected "${expectedKind}", got "${h.kind}"`);
  }
  return { schema: h.schema, kind: h.kind };
}

/** Every §2.1 envelope field is present and well-typed. Throws with the
 *  offending field named, mirroring the P1c assertions. */
export function assertEnvelope(row: Record<string, unknown>, fileLabel: string): void {
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in row)) {
      throw new Error(`${fileLabel}: record ${JSON.stringify((row as { rid?: unknown }).rid)} is missing envelope field "${field}"`);
    }
  }
  const prov = row.prov as Record<string, unknown> | undefined;
  if (!prov || !["human", "llm", "tool"].includes(prov.source as string)) {
    throw new Error(`${fileLabel}: prov.source must be human|llm|tool`);
  }
  if (typeof prov.who !== "string") throw new Error(`${fileLabel}: prov.who must be a string`);
  if (typeof row.rid !== "string") throw new Error(`${fileLabel}: rid must be a string`);
  if (typeof row.target !== "string") throw new Error(`${fileLabel}: target must be a string`);
  if (typeof row.ts !== "string") throw new Error(`${fileLabel}: ts must be a string`);
  if (!(row.supersedes === null || typeof row.supersedes === "string")) {
    throw new Error(`${fileLabel}: supersedes must be string|null`);
  }
  if (typeof row.active !== "boolean") throw new Error(`${fileLabel}: active must be a boolean`);
  if (typeof row.ctx !== "object" || row.ctx === null) throw new Error(`${fileLabel}: ctx must be an object`);
}

/** §2.2's sort key: rows are ordered by `(target, rid)`, both compared as
 *  plain strings (ascending). */
export function rowSortKey(row: { readonly target: string; readonly rid: string }): [string, string] {
  return [row.target, row.rid];
}

export function compareRows(a: { readonly target: string; readonly rid: string }, b: { readonly target: string; readonly rid: string }): number {
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  if (a.rid !== b.rid) return a.rid < b.rid ? -1 : 1;
  return 0;
}

/** True when two store headers describe the SAME decompile (§2.3's merge
 *  precondition, reviewer ruling 4 / edit E3): merges, and any other
 *  cross-store operation, refuse unless this holds — across different bytes
 *  the same `fn:N` can resolve to a different function, so a mismatch is
 *  never safe to paper over. */
export function sameBuiltFor(a: ProjectHeader, b: ProjectHeader): boolean {
  return a.builtFor.bundleSha256 === b.builtFor.bundleSha256;
}

export function assertSameBuiltFor(a: ProjectHeader, b: ProjectHeader, opLabel: string): void {
  if (!sameBuiltFor(a, b)) {
    throw new Error(
      `${opLabel} refused: builtFor.bundleSha256 mismatch (${a.builtFor.bundleSha256} vs ${b.builtFor.bundleSha256}) — ` +
        `cross-decompile ${opLabel} is refused per spec 11 §2.3 (a matching fn:N can name a different function across builds)`,
    );
  }
}
