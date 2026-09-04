// `ProjectService` — docs/specs/11-project-store.md §3.2, §7 step 5.
//
// The resident front-end over the four record-type stores (steps 2-4),
// composed over ONE loaded `project/` directory plus the warm `ArtifactService`
// index it shares (mirrors `ArtifactService`/`NameService`'s own "parse/load
// once, stay warm" pattern, per §3's "follows ArtifactService/NameService").
// `hbc2js project <verb>` (src/cli.ts) is a thin formatting wrapper over this
// class, same split as `query`'s CLI is over `ArtifactService`.
//
// Scope note: §3.2 lists `orphans()`/`conflicts()` in the API shape.
// Orphan DETECTION (§2.5, step 6) is implemented below: every read that
// used to filter on `active` alone now also excludes a record whose
// `target` no longer resolves against the live `ArtifactService` index
// (`src/project/orphans.ts`'s `isOrphaned`, live-computed every call, never
// cached — §3.3), and `orphans()`/`stat().orphans` report them with their
// write-time `ctx` snapshot. `mergeFrom`/`conflicts()`/`stat().conflicts`
// (§2.3, step 7) are implemented in terms of `src/project/merge.ts`'s pure
// merge function; a `conflict`-kind row is minted only by a merge, never by
// ordinary writes.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ArtifactService } from "../artifact/service.ts";
import { parseKey } from "../name-overlay/id.ts";
import { loadProjectStore, saveProjectStore, type ProjectStore } from "./io.ts";
import { dbPath } from "../projdb/artifact-read.ts";
import { openProjectDb } from "../projdb/db.ts";
import { loadProjectStoreFromDb } from "../projdb/project-read.ts";
import { exportWriteEffect } from "../projdb/export.ts";
import {
  dbAddComment,
  dbGetName,
  dbListSuggestedNames,
  dbSetBookmark,
  dbSetFinding,
  dbSetName,
  dbSetTag,
  findingAdapter,
  type FindingValue,
} from "../projdb/annotations.ts";
import { DbRevisionStore, type DbCtxSnapshot, type DbProvenance } from "../projdb/revision-store.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import {
  PROJECT_SCHEMA,
  type BookmarkRecord,
  type CommentRange,
  type CommentRecord,
  type ConflictRecord,
  type CtxSnapshot,
  type EvidenceRef,
  type FindingStatus,
  type Provenance,
  type Severity,
  type Tag,
  type TagRecord,
} from "./schema.ts";
import { TagStore } from "./tags.ts";
import { CommentStore } from "./comments.ts";
import { BookmarkStore } from "./bookmarks.ts";
import { FindingStore, checkStatusTransition, type AddFindingInput, type ResolvedFinding } from "./findings.ts";
import { ArtifactEvidenceResolver, hasResolvingEvidence } from "./evidence-resolver.ts";
import { collectOrphans, isOrphaned, type OrphanRow, type TargetIndexCheck } from "./orphans.ts";
import { mergeStores } from "./merge.ts";

export interface Bounded<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

/** §3.1's caps, one constant per bounded verb. */
export const PROJECT_CAPS = {
  forFn: 40,
  findings: 50,
  comments: 30,
  bookmarks: 50,
  tagsGet: 10,
  orphans: 50,
  conflicts: 50,
} as const;

export type AnnotationRow =
  | { readonly type: "tag"; readonly record: TagRecord }
  | { readonly type: "comment"; readonly record: CommentRecord }
  | { readonly type: "finding"; readonly record: ResolvedFinding };

export interface SetResult {
  readonly rid: string;
  /** §3.1's one-line confirmation shape, already formatted — the CLI prints
   *  this verbatim rather than re-deriving it, so the service and CLI never
   *  disagree on what a write verb reports. */
  readonly line: string;
}

export interface StatRow {
  readonly comments: number;
  readonly tags: number;
  readonly bookmarks: number;
  readonly findings: number;
  readonly invalidFindings: number;
  /** Full (uncapped) orphan count (§2.5), live-computed. */
  readonly orphans: number;
  /** Full (uncapped) count of `conflict` records minted by a merge (§2.3). */
  readonly conflicts: number;
}

/** The target's owning function, when `target` is in the `fn:`/`reg:`/`env:`
 *  binding-id vocabulary (`src/name-overlay/id.ts`'s `bindingKey` scheme,
 *  which this store's `target` strings reuse — confirmed by
 *  `evidence-resolver.ts`'s `reg:F:R` parsing, step 4). `null` for a target
 *  outside that vocabulary (`sid:N`, `mod:N`, …), which owns no function. */
function ownerFn(target: string): number | null {
  try {
    return parseKey(target).fn;
  } catch {
    return null;
  }
}

function provLine(prov: Provenance): string {
  return prov.run !== undefined ? `${prov.source}:${prov.who}@${prov.run}` : `${prov.source}:${prov.who}`;
}

/** `Provenance`/`CtxSnapshot` (JSONL engine shape, `run?: string`) ->
 *  `DbProvenance`/`DbCtxSnapshot` (DB engine shape, `run?: string | null`)
 *  — structurally compatible, this is just the explicit `?? null` normalise
 *  `annotations.ts`'s `db*` verbs expect for their bound params. */
function toDbProv(prov: Provenance): DbProvenance {
  return { source: prov.source, who: prov.who, run: prov.run ?? null, tier: prov.tier ?? "accepted" };
}

/** The read-side inverse of `toDbProv`, for `getName`/`listSuggestedNames`
 *  (§15) — `DbProvenance` (`run?: string | null`, always-present `tier`) ->
 *  `Provenance` (`run?: string`, `tier` only when not the default). */
function fromDbProv(prov: DbProvenance): Provenance {
  return {
    source: prov.source,
    who: prov.who,
    ...(prov.run !== undefined && prov.run !== null ? { run: prov.run } : {}),
    ...(prov.tier !== undefined && prov.tier !== null && prov.tier !== "accepted" ? { tier: prov.tier } : {}),
  };
}

function toDbCtx(ctx: CtxSnapshot): DbCtxSnapshot {
  return { name: ctx.name ?? null, loc: ctx.loc ?? null, ownerFn: ctx.ownerFn ?? null };
}

function emptyStore(dir: string, bundleSha256: string): ProjectStore {
  return {
    dir,
    header: { schema: PROJECT_SCHEMA, kind: "header", seq: { comments: 0, tags: 0, bookmarks: 0, findings: 0 }, builtFor: { bundleSha256 } },
    comments: [],
    tags: [],
    bookmarks: [],
    findings: [],
  };
}

export class ProjectService {
  private readonly artifact: ArtifactService;
  private readonly storeDir: string;
  private readonly resolver: ArtifactEvidenceResolver;
  private tagStore: TagStore;
  private commentStore: CommentStore;
  private bookmarkStore: BookmarkStore;
  private findingStore: FindingStore;
  /** `conflict`-kind rows (§2.3, §7 step 7) pulled out of each file's row
   *  set on load — `TagStore`/`CommentStore`/`BookmarkStore`/`FindingStore`
   *  only know their own record shape, so a `conflict` row (which lacks a
   *  `.tag`/`.body`/`.label`/`.claim`) is carried here instead and spliced
   *  back into the file's rows on `save()`. */
  private conflictRecords: { comments: ConflictRecord[]; tags: ConflictRecord[]; bookmarks: ConflictRecord[]; findings: ConflictRecord[] };

  private readonly targetIndex: TargetIndexCheck;

  /** Open, retained `.hbcproj` write handle when `artifact.dbBacked`
   *  (prerequisite flagged by the read core, `src/mcp/resources.ts`'s own
   *  header note: "`ProjectService`'s OWN write verbs still land in JSONL
   *  even for a DB-backed project"). `null` for a JSONL-backed project.
   *  Every write verb below branches on this field: DB-backed, it calls
   *  straight through `src/projdb/annotations.ts`'s `db*` verbs (each of
   *  which appends exactly one `revisions` row + exactly one `log` row in
   *  one transaction, spec 16 §2.3/A3) instead of `save()`'s JSONL
   *  round-trip, then reloads the in-memory read caches so this instance's
   *  OWN subsequent reads see the write immediately (mirrors `applyStore`
   *  after `mergeFrom`). Never closed by this class — the caller owns the
   *  artifact directory's lifetime, same as `ArtifactService` never closes
   *  its own handles either. */
  private readonly db: DatabaseSync | null;

  /** `.hbcproj`'s own directory (== `artifactDir`, `dbPath`'s convention,
   *  `src/projdb/artifact-read.ts`) — where `analysis/`+`log/` live (§3).
   *  Only meaningful when `db !== null`; passed to `exportWriteEffect`
   *  (`src/projdb/export.ts`, §6 step 3 / §R4 step 2) by every DB-backed
   *  write verb below, right after its own write commits. */
  private readonly projectDir: string;

  /** `artifactDir` is the SAME directory `artifact` was built from (its
   *  `project/` subdirectory is this store, §2.2); `artifact` is the shared
   *  warm index (§3.2's "shares the warm index"). Bootstraps an empty store
   *  (keyed to the artifact's own `builtFor`) when `project/` doesn't exist
   *  yet; otherwise loads it. A `builtFor` mismatch is NO LONGER refused
   *  (that was step 5's stub, §2.5's "relaxed into live orphan-flagging once
   *  step 6 lands" — this is step 6): opening a store whose `builtFor`
   *  differs from this artifact is exactly the cross-version case §2.5
   *  specs, so every read below live-resolves each record's `target`
   *  against `artifact` and excludes what no longer resolves — never a
   *  refusal, never a silent drop. */
  constructor(artifactDir: string, artifact: ArtifactService) {
    this.artifact = artifact;
    this.projectDir = artifactDir;
    this.storeDir = join(artifactDir, "project");
    const bundleSha256 = artifact.manifest.bundle.sha256;
    // §4.3 backend selection, same rule as `ArtifactService`: `artifact`
    // already decided (and, on construction, already ran the §5.2
    // staleness checks — a stale DB never reaches this far). When DB-backed,
    // the annotation stratum comes from `project.hbcproj`'s `revisions`
    // table (`src/projdb/project-read.ts`, reusing step 3's
    // `DbRevisionStore`) instead of `project/*.jsonl`, which is ignored
    // per §4.3's coexistence rule.
    let store: ProjectStore;
    if (artifact.dbBacked) {
      // Writable, not readonly (§4.3's read layer opens readonly for
      // queries; a write-capable `ProjectService` needs the same handle
      // annotations.ts's `db*` verbs write through, retained for the life
      // of this instance per the prerequisite above).
      this.db = openProjectDb(dbPath(artifactDir));
      store = loadProjectStoreFromDb(this.db, this.storeDir, bundleSha256);
    } else {
      this.db = null;
      store = existsSync(this.storeDir) ? loadProjectStore(this.storeDir) : emptyStore(this.storeDir, bundleSha256);
    }
    this.targetIndex = {
      hasFn: (fn) => artifact.hasFn(fn),
      hasString: (sid) => artifact.hasString(sid),
      hasModule: (id) => artifact.hasModule(id),
    };
    this.resolver = new ArtifactEvidenceResolver(artifact);
    this.tagStore = new TagStore();
    this.commentStore = new CommentStore();
    this.bookmarkStore = new BookmarkStore();
    this.findingStore = new FindingStore();
    this.conflictRecords = { comments: [], tags: [], bookmarks: [], findings: [] };
    this.applyStore(store);
  }

  /** (Re)builds the four record-type sub-stores plus the pulled-out
   *  `conflict` rows from a loaded/merged `ProjectStore` — the constructor's
   *  own logic, factored out so `mergeFrom` (§7 step 7) can reuse it after
   *  replacing the in-memory rows with a merge result. */
  private applyStore(store: ProjectStore): void {
    const isConflict = (r: { readonly kind: string }): r is ConflictRecord => r.kind === "conflict";
    this.conflictRecords = {
      comments: store.comments.filter(isConflict),
      tags: store.tags.filter(isConflict),
      bookmarks: store.bookmarks.filter(isConflict),
      findings: store.findings.filter(isConflict),
    };
    this.tagStore = new TagStore({ records: store.tags.filter((r): r is TagRecord => !isConflict(r)) });
    this.commentStore = new CommentStore({ records: store.comments.filter((r): r is CommentRecord => !isConflict(r)) });
    this.bookmarkStore = new BookmarkStore({ records: store.bookmarks.filter((r): r is BookmarkRecord => !isConflict(r)) });
    this.findingStore = new FindingStore({
      findings: store.findings.filter((r) => r.kind === "finding"),
      statuses: store.findings.filter((r) => r.kind === "status"),
    });
  }

  /** Re-derives the four in-memory read caches from the open DB handle —
   *  called after every DB-backed write so THIS instance's own subsequent
   *  reads (`forFn`, `findings`, …) see the write it just made, without
   *  re-opening the file (mirrors `mergeFrom`'s own `applyStore` call after
   *  a merge). No-op for a JSONL-backed project (nothing to reload; that
   *  path's in-memory stores ARE the write target). */
  private reloadFromDb(): void {
    if (this.db === null) return;
    this.applyStore(loadProjectStoreFromDb(this.db, this.storeDir, this.artifact.manifest.bundle.sha256));
  }

  /** §6 step 3 / §R4 step 2: called right after EVERY DB-backed write verb's
   *  own `db*`/`DbRevisionStore` call commits, with the `rid` it just
   *  minted — materialises that write's affected shard(s) and appends one
   *  chained `log/` entry for it (`exportWriteEffect`), so the durable
   *  `analysis/`+`log/` tree stays live-synced with `cache.db` write for
   *  write, not just at the next one-shot `hbcproj export` (§8's "file is
   *  the durable authority" model). No-op for a JSONL-backed project (no
   *  `db`, nothing to export). */
  private exportWrite(rid: string): void {
    if (this.db === null) return;
    exportWriteEffect(this.db, this.projectDir, Number(rid));
  }

  /** Persist every record-type file + `project.json` back to `<artifact>/
   *  project/` (creating the directory on first save, §2.2's exact file
   *  set). Every write verb below calls this so a one-shot CLI invocation
   *  round-trips to disk; a resident caller (the loop) may batch several
   *  writes and call `save()` once. */
  save(): void {
    // DB-backed: nothing to do here — every write verb below persists its
    // own row (+ its own `log` row) transactionally through `db.ts`'s open
    // handle the moment it's called; there is no JSONL file to flush.
    if (this.db !== null) return;
    if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true });
    const comments = [...this.commentStore.allRecords(), ...this.conflictRecords.comments];
    const tags = [...this.tagStore.allRecords(), ...this.conflictRecords.tags];
    const bookmarks = [...this.bookmarkStore.allRecords(), ...this.conflictRecords.bookmarks];
    const findings = [...this.findingStore.allRecords(), ...this.conflictRecords.findings];
    saveProjectStore({
      dir: this.storeDir,
      header: {
        schema: PROJECT_SCHEMA,
        kind: "header",
        seq: { comments: comments.length, tags: tags.length, bookmarks: bookmarks.length, findings: findings.length },
        builtFor: { bundleSha256: this.artifact.manifest.bundle.sha256 },
      },
      comments,
      tags,
      bookmarks,
      findings,
    });
  }

  /** `project merge <otherDir>` (§2.3, §7 step 7): line-unions `otherDir`'s
   *  `project/` store into this one and persists the result. Refuses (the
   *  thrown error is the CLI's failure message) unless both stores'
   *  `builtFor.bundleSha256` match (§2.3, reviewer ruling 4) — checked
   *  BEFORE any in-memory state changes, so a refused merge leaves this
   *  store exactly as it was. Returns the number of `conflict` records
   *  minted (0 when the two stores never touched the same slot). */
  mergeFrom(otherArtifactDir: string): { readonly conflictCount: number } {
    const otherStoreDir = join(otherArtifactDir, "project");
    const other = loadProjectStore(otherStoreDir);
    const self: ProjectStore = {
      dir: this.storeDir,
      header: { schema: PROJECT_SCHEMA, kind: "header", seq: { comments: 0, tags: 0, bookmarks: 0, findings: 0 }, builtFor: { bundleSha256: this.artifact.manifest.bundle.sha256 } },
      comments: [...this.commentStore.allRecords(), ...this.conflictRecords.comments],
      tags: [...this.tagStore.allRecords(), ...this.conflictRecords.tags],
      bookmarks: [...this.bookmarkStore.allRecords(), ...this.conflictRecords.bookmarks],
      findings: [...this.findingStore.allRecords(), ...this.conflictRecords.findings],
    };
    const { store, conflictCount } = mergeStores(self, other);
    this.applyStore(store);
    this.save();
    return { conflictCount };
  }

  /** §2.5/§3.3: is `target` orphaned against the currently-loaded artifact,
   *  live-computed every call. Every read below that used to filter on
   *  `active` alone also excludes an orphaned target. */
  private orphaned(target: string): boolean {
    return isOrphaned(target, this.targetIndex);
  }

  private captureCtx(target: string): CtxSnapshot {
    const fn = ownerFn(target);
    if (fn === null || !this.artifact.hasFn(fn)) return {};
    const summary = this.artifact.fn(fn);
    return {
      ...(summary.overlayName ?? summary.name ? { name: (summary.overlayName ?? summary.name) as string } : {}),
      ...(summary.file !== null && summary.lines !== null ? { loc: `${summary.file}:${summary.lines[0]}` } : {}),
      ownerFn: `fn:${fn}`,
    };
  }

  // --- reads ------------------------------------------------------------

  /** §3.1 `project for-fn <fn>` — every active, NON-ORPHANED (§2.5)
   *  tag/comment/finding whose target is `fn:N` or a `reg:N:*`/`env:N:*`
   *  owned by it, one row each, bounded (§3.1's aggregating read the loop
   *  leans on). */
  forFn(fn: number, page: { readonly all?: boolean } = {}): Bounded<AnnotationRow> {
    const rows: AnnotationRow[] = [
      ...this.tagStore
        .allRecords()
        .filter((r) => r.active && ownerFn(r.target) === fn && !this.orphaned(r.target))
        .map((record): AnnotationRow => ({ type: "tag", record })),
      ...this.commentStore
        .allRecords()
        .filter((r) => r.active && ownerFn(r.target) === fn && !this.orphaned(r.target))
        .map((record): AnnotationRow => ({ type: "comment", record })),
      ...this.findingStore
        .findings(this.resolver, {}, { all: true })
        .rows.filter((rf) => ownerFn(rf.record.target) === fn && !this.orphaned(rf.record.target))
        .map((record): AnnotationRow => ({ type: "finding", record })),
    ];
    const key = (r: AnnotationRow): { readonly target: string; readonly rid: string } => (r.type === "finding" ? r.record.record : r.record);
    rows.sort((a, b) => key(a).target.localeCompare(key(b).target) || key(a).rid.localeCompare(key(b).rid));
    const cap = page.all === true ? rows.length : PROJECT_CAPS.forFn;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project tag get <id>` — empty when `target` itself is orphaned
   *  (§2.5: orphaned targets are excluded from active reads). */
  tagsOn(target: string): Bounded<TagRecord> {
    const rows = this.orphaned(target) ? [] : this.tagStore.getTags(target);
    const cap = PROJECT_CAPS.tagsGet;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project findings [--tag] [--severity] [--status]`. `tag` filters
   *  to findings whose TARGET carries that active tag (a finding has no tag
   *  field of its own, §1.5) — cross-referencing the tag store. Orphaned
   *  targets (§2.5) are excluded, same as an invalid (unresolving-evidence)
   *  finding. */
  findings(
    query: { readonly tag?: Tag; readonly severity?: Severity; readonly status?: FindingStatus } = {},
    page: { readonly all?: boolean } = {},
  ): Bounded<ResolvedFinding> {
    const { severity, status } = query;
    const all = this.findingStore
      .findings(this.resolver, { ...(severity !== undefined ? { severity } : {}), ...(status !== undefined ? { status } : {}) }, { all: true })
      .rows.filter((rf) => !this.orphaned(rf.record.target));
    const filtered = query.tag !== undefined ? all.filter((rf) => this.tagStore.getTags(rf.record.target).some((t) => t.tag === query.tag)) : all;
    const cap = page.all === true ? filtered.length : PROJECT_CAPS.findings;
    return { rows: filtered.slice(0, cap), total: filtered.length, truncated: filtered.length > cap };
  }

  /** §3.1 `project finding show <id>` — never excludes an invalid finding
   *  (§4.1: "not shown live", not vanished). */
  finding(rid: string): ResolvedFinding | null {
    return this.findingStore.finding(rid, this.resolver);
  }

  /** §3.1 `project comments <fn>` — orphaned comments (§2.5) excluded. */
  comments(fn: number, page: { readonly all?: boolean } = {}): Bounded<CommentRecord> {
    const rows = this.commentStore
      .forTarget(`fn:${fn}`)
      .concat(this.commentStore.allRecords().filter((r) => r.active && r.target !== `fn:${fn}` && ownerFn(r.target) === fn))
      .filter((r) => !this.orphaned(r.target));
    const cap = page.all === true ? rows.length : PROJECT_CAPS.comments;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project bookmarks [--fn N]` — orphaned bookmarks (§2.5) excluded. */
  bookmarks(query: { readonly fn?: number } = {}, page: { readonly all?: boolean } = {}): Bounded<BookmarkRecord> {
    const rows = this.bookmarkStore
      .allRecords()
      .filter((r) => r.active && (query.fn === undefined || ownerFn(r.target) === query.fn) && !this.orphaned(r.target));
    const cap = page.all === true ? rows.length : PROJECT_CAPS.bookmarks;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project orphans` (§2.5, this step): every active record across
   *  all four record types whose `target` no longer resolves against the
   *  live artifact, with its write-time `ctx` snapshot — live-computed every
   *  call (§3.3), never a mutation of the stored line. Bounded per §3.1. */
  orphans(page: { readonly all?: boolean } = {}): Bounded<OrphanRow> {
    const rows = collectOrphans(
      [
        ...this.tagStore.allRecords().map((r) => ({ kind: "tag", rid: r.rid, target: r.target, active: r.active, ctx: r.ctx })),
        ...this.commentStore.allRecords().map((r) => ({ kind: "comment", rid: r.rid, target: r.target, active: r.active, ctx: r.ctx })),
        ...this.bookmarkStore.allRecords().map((r) => ({ kind: "bookmark", rid: r.rid, target: r.target, active: r.active, ctx: r.ctx })),
        ...this.findingStore.allRecords().map((r) => ({ kind: r.kind, rid: r.rid, target: r.target, active: r.active, ctx: r.ctx })),
      ],
      this.targetIndex,
    );
    const cap = page.all === true ? rows.length : PROJECT_CAPS.orphans;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project conflicts` (§2.3, §7 step 7) — every contested slot: a
   *  `conflict` record minted by a prior `project merge` (module header),
   *  across all four record types, sorted `(target, rid)`, bounded. */
  conflicts(page: { readonly all?: boolean } = {}): Bounded<{ readonly file: string; readonly record: ConflictRecord }> {
    const rows = [
      ...this.conflictRecords.comments.map((record) => ({ file: "comments", record })),
      ...this.conflictRecords.tags.map((record) => ({ file: "tags", record })),
      ...this.conflictRecords.bookmarks.map((record) => ({ file: "bookmarks", record })),
      ...this.conflictRecords.findings.map((record) => ({ file: "findings", record })),
    ].sort((a, b) => a.record.target.localeCompare(b.record.target) || a.record.rid.localeCompare(b.record.rid));
    const cap = page.all === true ? rows.length : PROJECT_CAPS.conflicts;
    return { rows: rows.slice(0, cap), total: rows.length, truncated: rows.length > cap };
  }

  /** §3.1 `project stat`. `orphans` is the FULL (uncapped) orphan count
   *  across all record types (§2.5), matching `orphans({all:true}).total`. */
  stat(): StatRow {
    const findingRows = this.findingStore.allFindings().filter((r) => r.active);
    const invalid = findingRows.filter((r) => !this.findingStore.resolve(r, this.resolver).valid).length;
    return {
      comments: this.commentStore.allRecords().filter((r) => r.active).length,
      tags: this.tagStore.allRecords().filter((r) => r.active).length,
      bookmarks: this.bookmarkStore.allRecords().filter((r) => r.active).length,
      findings: findingRows.length,
      invalidFindings: invalid,
      orphans: this.orphans({ all: true }).total,
      conflicts: this.conflicts({ all: true }).total,
    };
  }

  // --- writes -------------------------------------------------------------
  //
  // Every verb below branches on `this.db`: DB-backed, it writes straight
  // through `annotations.ts`'s `db*` verb (one `revisions` row + one `log`
  // row, transactional, spec 16 §2.3/A3) then calls `reloadFromDb()` so this
  // instance's own subsequent reads see the write; JSONL-backed, it keeps
  // the pre-existing in-memory-engine + `save()` path unchanged (prompt's
  // "keep JSONL-backed projects working unchanged").

  /** `set_name` (docs/specs/17-mcp-harness.md §2): DB-backed only this
   *  round — `dbSetName`/`d_names` IS the DB-native counterpart of the
   *  Design-D overlay's `OverlayStore.setName` (same one-append-plus-one-
   *  log-row contract every other write verb here gets), but wiring a
   *  JSONL-backed project's name write through the SEPARATE overlay store
   *  (`src/name-overlay/`, its own gate/frame-body machinery, no `log`
   *  table at all) is out of this round's scope — `ProjectService` is
   *  constructed from just an `ArtifactService`, not the module bodies the
   *  overlay's gate needs. Refuses cleanly rather than silently no-op'ing;
   *  tracked in `docs/BUGS.md`. Resolves `target` against the live index
   *  BEFORE accepting (spec 11 §3.2), same rule `record_finding`'s evidence
   *  gate uses. */
  setName(target: string, name: string, prov: Provenance): SetResult {
    if (this.db === null) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, "set_name: JSONL-backed projects don't support name writes via ProjectService yet (docs/BUGS.md) — use the Design-D overlay (`hbc2js name set`) directly");
    }
    if (!this.resolver.resolves(target)) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, `set_name: ${target} does not resolve against the live artifact index (spec 11 §3.2)`);
    }
    const { record } = dbSetName(this.db, target, name, toDbProv(prov), { ctx: toDbCtx(this.captureCtx(target)) });
    this.exportWrite(record.rid);
    this.reloadFromDb();
    return { rid: record.rid, line: `named ${target} "${name}" [${provLine(prov)}]` };
  }

  /** §3.1 `project tag set <id> <tag> [--note]`. */
  setTag(target: string, tag: Tag, prov: Provenance, opts?: { readonly note?: string }): SetResult {
    if (this.db !== null) {
      const { record } = dbSetTag(this.db, target, tag, toDbProv(prov), { ...(opts?.note !== undefined ? { note: opts.note } : {}), ctx: toDbCtx(this.captureCtx(target)) });
      this.exportWrite(record.rid);
      this.reloadFromDb();
      return { rid: record.rid, line: `tagged ${target} ${tag} [${provLine(prov)}]` };
    }
    const { record } = this.tagStore.setTag(target, tag, prov, { ...(opts?.note !== undefined ? { note: opts.note } : {}), ctx: this.captureCtx(target) });
    this.save();
    return { rid: record.rid, line: `tagged ${target} ${tag} [${provLine(prov)}]` };
  }

  /** §3.1 `project comment add <target> [--range L] --body <s>`. */
  addComment(target: string, body: string, prov: Provenance, opts?: { readonly range?: CommentRange }): SetResult {
    if (this.db !== null) {
      const { record } = dbAddComment(this.db, target, body, toDbProv(prov), { ...(opts?.range !== undefined ? { range: opts.range } : {}), ctx: toDbCtx(this.captureCtx(target)) });
      this.exportWrite(record.rid);
      this.reloadFromDb();
      return { rid: record.rid, line: `commented ${target}${opts?.range !== undefined ? ` L${opts.range.line}` : ""} [${provLine(prov)}]` };
    }
    const { record } = this.commentStore.addComment(target, body, prov, { ...(opts?.range !== undefined ? { range: opts.range } : {}), ctx: this.captureCtx(target) });
    this.save();
    return { rid: record.rid, line: `commented ${target}${record.range !== undefined ? ` L${record.range.line}` : ""} [${provLine(prov)}]` };
  }

  /** Not a §3.1-tabled read verb but named by this step's brief ("write
   *  verbs … finding add"): mints a fresh finding (§4.1's write-time gate —
   *  rejects zero/unresolving evidence). */
  addFinding(input: AddFindingInput): SetResult {
    if (this.db !== null) {
      if (!hasResolvingEvidence(input.evidence, this.resolver)) {
        throw new Hbc2jsError(
          ErrorCode.E_USAGE,
          `record_finding: rejected — a finding needs >=1 evidence ref and at least one must resolve (spec 11 §4.1); got ${input.evidence.length} ref(s), none resolving`,
        );
      }
      const findingNo = ((this.db.prepare("SELECT COALESCE(MAX(finding_no),0)+1 AS n FROM d_findings").get() as { n: number }).n);
      const value: FindingValue = {
        findingNo,
        severity: input.severity,
        status: "open", // a finding never self-confirms at creation (§4.1) — always minted `open`.
        claim: input.claim,
        evidence: input.evidence.map((e) => ({ ref: e.ref, role: e.role })),
      };
      const { record } = dbSetFinding(this.db, input.target, value, toDbProv(input.prov), {
        ...(input.patternId !== undefined ? { patternId: input.patternId } : {}),
        ctx: toDbCtx(input.ctx ?? this.captureCtx(input.target)),
      });
      this.exportWrite(record.rid);
      this.reloadFromDb();
      return { rid: record.rid, line: `finding#${findingNo} ${input.severity} open ${input.target} [${provLine(input.prov)}]` };
    }
    const { record } = this.findingStore.addFinding({ ...input, ctx: input.ctx ?? this.captureCtx(input.target) }, this.resolver);
    this.save();
    return { rid: record.rid, line: `finding#${record.rid} ${record.severity} open ${record.target} [${provLine(record.prov)}]` };
  }

  /** §3.1 `project finding set-status <id> <status> --evidence <ref…>`.
   *  DB-backed path: `revisions.kind='status'`/`d_status` (a dedicated
   *  detail table for the transition itself) is a documented scope gap
   *  (`docs/BUGS.md`, project-DB step 4 row) — schema.sql DDL is out of
   *  this round's file list. Transitions are represented instead as a
   *  FRESH `kind='finding'` revision on the SAME slot (found via `rid`'s
   *  `slot`, so it resolves regardless of which historical rid the caller
   *  names — the DB engine's own supersession-chain equivalent of the
   *  JSONL engine's `finding()` chain-follow), with `status` updated and
   *  the transition's OWN evidence refs APPENDED to (never replacing) the
   *  finding's original evidence — so the finding's original claim
   *  evidence stays live-resolvable on every later read, exactly as the
   *  JSONL `finding`/`status` split keeps them independently. Still exactly
   *  one `revisions` row + one `log` row per call (`DbRevisionStore.set`). */
  setFindingStatus(findingRid: string, to: FindingStatus, evidence: readonly EvidenceRef[], prov: Provenance): SetResult {
    if (this.db !== null) {
      const ridNum = Number(findingRid);
      const row = this.db.prepare("SELECT slot, target FROM revisions WHERE rid = ? AND kind = 'finding'").get(ridNum) as { slot: string; target: string } | undefined;
      if (row === undefined) throw new Hbc2jsError(ErrorCode.E_USAGE, `set_finding_status: no such finding ${JSON.stringify(findingRid)}`);
      const store = new DbRevisionStore(this.db, findingAdapter);
      const current = store.get(row.slot);
      if (current === undefined) throw new Hbc2jsError(ErrorCode.E_USAGE, `set_finding_status: finding ${JSON.stringify(findingRid)} has no active revision (cleared)`);
      const from = current.value.status as FindingStatus;
      const violation = checkStatusTransition(from, to, evidence, prov, this.resolver);
      if (violation !== null) throw new Hbc2jsError(ErrorCode.E_USAGE, `set_finding_status: rejected — ${violation}`);
      const value: FindingValue = {
        findingNo: current.value.findingNo,
        severity: current.value.severity,
        status: to,
        claim: current.value.claim,
        evidence: [...current.value.evidence, ...evidence.map((e) => ({ ref: e.ref, role: e.role }))],
      };
      const { record } = store.set(row.slot, row.target, value, toDbProv(prov), { ctx: toDbCtx(this.captureCtx(row.target)) });
      this.exportWrite(record.rid);
      this.reloadFromDb();
      return { rid: record.rid, line: `finding#${current.value.findingNo} -> ${to} [${provLine(prov)}]` };
    }
    const existing = this.findingStore.finding(findingRid, this.resolver);
    const ctx = existing !== null ? this.captureCtx(existing.record.target) : {};
    const { record } = this.findingStore.setStatus({ findingRid, to, evidence, prov, ctx }, this.resolver);
    this.save();
    return { rid: record.rid, line: `finding#${findingRid} -> ${to} [${provLine(prov)}]` };
  }

  /** Write verb named by this step's brief, not §3.1-tabled (bookmarks is
   *  otherwise read-only in the verb table): `project bookmark add`. */
  addBookmark(target: string, prov: Provenance, opts?: { readonly label?: string }): SetResult {
    if (this.db !== null) {
      const { record } = dbSetBookmark(this.db, target, toDbProv(prov), { ...(opts?.label !== undefined ? { label: opts.label } : {}), ctx: toDbCtx(this.captureCtx(target)) });
      this.exportWrite(record.rid);
      this.reloadFromDb();
      return { rid: record.rid, line: `bookmarked ${target}${opts?.label !== undefined ? ` "${opts.label}"` : ""} [${provLine(prov)}]` };
    }
    const { record } = this.bookmarkStore.setBookmark(target, prov, { ...(opts?.label !== undefined ? { label: opts.label } : {}), ctx: this.captureCtx(target) });
    this.save();
    return { rid: record.rid, line: `bookmarked ${target}${record.label !== undefined ? ` "${record.label}"` : ""} [${provLine(prov)}]` };
  }

  // --- log / history (spec 16 §3.2) — DB-native, prerequisite this round --

  /** `log[?since&who]` — same shape/cap as `McpResources.log` (which reads
   *  the SAME table over its own readonly handle for a JSONL-caller that
   *  hasn't constructed a `ProjectService`); this is the resident
   *  counterpart, over the already-open write handle, so a caller doing a
   *  batch of writes then a `log` read never re-opens the file. Throws for
   *  a JSONL-backed project (no `log` table exists, spec 16 §2.2). */
  log(query: { readonly since?: string; readonly who?: string } = {}, opts: { readonly all?: boolean } = {}): Bounded<LogRow> {
    if (this.db === null) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, "log: this project has no project.hbcproj (JSONL-backed projects do not carry a change log, spec 16 §2.2)");
    }
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(query.since);
    }
    if (query.who !== undefined) {
      clauses.push("actor_who = ?");
      params.push(query.who);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM log ${where}`).get(...params) as { n: number }).n;
    const cap = opts.all === true ? total : LOG_CAP;
    const rows = this.db
      .prepare(`SELECT seq, ts, actor_who AS who, op, detail FROM log ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, cap + 1) as unknown as LogRow[];
    return { rows: rows.slice(0, cap), total, truncated: rows.length > cap };
  }

  /** `history/{target}` — the full `revisions` supersession/revert timeline
   *  for one binding-id target, newest first. Same shape/cap/scope note as
   *  `log` above. */
  history(target: string, opts: { readonly all?: boolean } = {}): Bounded<HistoryRow> {
    if (this.db === null) {
      throw new Hbc2jsError(ErrorCode.E_USAGE, "history: this project has no project.hbcproj (JSONL-backed projects do not carry a change log, spec 16 §2.2)");
    }
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM revisions WHERE target = ?").get(target) as { n: number }).n;
    const cap = opts.all === true ? total : HISTORY_CAP;
    const rows = this.db
      .prepare(`SELECT rid, kind, ts, supersedes, reactivates, cleared, prov_who AS who FROM revisions WHERE target = ? ORDER BY rid DESC LIMIT ?`)
      .all(target, cap + 1) as unknown as (Omit<HistoryRow, "cleared"> & { cleared: number })[];
    return { rows: rows.slice(0, cap).map((r) => ({ ...r, cleared: r.cleared !== 0 })), total, truncated: rows.length > cap };
  }

  /** docs/specs/17-mcp-harness.md §15 — the ACCEPTED name for `target` (the
   *  "name slot", spec 23 §4's own term), or `null` if none was ever set or
   *  this project is JSONL-backed (`setName`'s own scope gap, same as
   *  `dbGetName`'s slot never seeing a `'suggested'` write — see that
   *  function's doc comment). Read-only counterpart to `setName`. */
  getName(target: string): { readonly name: string; readonly prov: Provenance; readonly ts: string } | null {
    if (this.db === null) return null;
    const rev = dbGetName(this.db, target);
    if (rev === undefined) return null;
    return { name: rev.value.name, prov: fromDbProv(rev.prov), ts: rev.ts };
  }

  /** §15 — every proposer's live `'suggested'` name for `target`, exposed
   *  separately from `getName` (never affects it — different slot,
   *  `dbSetName`'s own doc comment). `[]` for a JSONL-backed project or a
   *  target with no suggestions. */
  listSuggestedNames(target: string): readonly { readonly rid: string; readonly name: string; readonly who: string; readonly run?: string; readonly ts: string }[] {
    if (this.db === null) return [];
    return dbListSuggestedNames(this.db, target).map((rev) => ({
      rid: rev.rid,
      name: rev.value.name,
      who: rev.prov.who,
      ...(rev.prov.run !== undefined && rev.prov.run !== null ? { run: rev.prov.run } : {}),
      ts: rev.ts,
    }));
  }
}

export interface LogRow {
  readonly seq: number;
  readonly ts: string;
  readonly who: string;
  readonly op: string;
  readonly detail: string | null;
}

export interface HistoryRow {
  readonly rid: number;
  readonly kind: string;
  readonly ts: string;
  readonly supersedes: number | null;
  readonly reactivates: number | null;
  readonly cleared: boolean;
  readonly who: string;
}

const LOG_CAP = 50;
const HISTORY_CAP = 40;
