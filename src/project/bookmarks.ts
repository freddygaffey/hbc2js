// The `bookmarks` record type — docs/specs/11-project-store.md §1.4, §7 step 3.
//
// Cheapest record type: no semantics beyond "come back here". One active
// bookmark per `target` — the slot key is `target` alone (§2.1's
// "(kind,target[,tag])" with no bracketed extra: bookmarks have no `tag`),
// so re-bookmarking the same target supersedes the prior label rather than
// stacking duplicates. Same `RevisionStore` wrapper shape as `tags.ts`.
import { RevisionStore } from "./revision-store.ts";
import type { Revision } from "./revision-store.ts";
import { assertProvenance } from "./schema.ts";
import type { BookmarkRecord, Provenance, CtxSnapshot } from "./schema.ts";

type BookmarkFields = Pick<BookmarkRecord, "label" | "prov" | "ctx">;

export interface SetBookmarkResult {
  readonly record: BookmarkRecord;
  readonly superseded: BookmarkRecord | null;
}

function toBookmarkRecord(r: Revision<BookmarkFields>): BookmarkRecord {
  const { label, prov, ctx } = r.value;
  return {
    rid: r.rid,
    kind: "bookmark",
    target: r.target,
    prov,
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx,
    ...(label !== undefined ? { label } : {}),
  };
}

function toRevision(r: BookmarkRecord): Revision<BookmarkFields> {
  return {
    rid: r.rid,
    target: r.target,
    value: { prov: r.prov, ctx: r.ctx, ...(r.label !== undefined ? { label: r.label } : {}) },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

export class BookmarkStore {
  private readonly engine: RevisionStore<BookmarkFields>;

  constructor(init?: { readonly records?: readonly BookmarkRecord[]; readonly seq?: number }) {
    this.engine = new RevisionStore<BookmarkFields>({
      ...(init?.records ? { records: init.records.map(toRevision) } : {}),
      ...(init?.seq !== undefined ? { seq: init.seq } : {}),
    });
  }

  set now(fn: () => string) {
    this.engine.now = fn;
  }

  allRecords(): readonly BookmarkRecord[] {
    return this.engine.allRecords().map(toBookmarkRecord);
  }

  /** The currently-active bookmark on `target`, or `undefined`. */
  get(target: string): BookmarkRecord | undefined {
    const r = this.engine.get(target);
    return r ? toBookmarkRecord(r) : undefined;
  }

  /** All active bookmarks, optionally scoped to one `fn:N` prefix — the
   *  `--fn` filter `project bookmarks` (§3.1) needs; a later step wires the
   *  CLI, this is the query it will call. */
  all(): readonly BookmarkRecord[] {
    return this.engine
      .allRecords()
      .filter((r) => r.active)
      .map(toBookmarkRecord);
  }

  history(target: string): readonly BookmarkRecord[] {
    return this.engine.history(target).map(toBookmarkRecord);
  }

  /** Bookmark `target` (§1.4/§4.2). Rejects a missing/malformed `prov`
   *  before minting a record (§4.2). */
  setBookmark(target: string, prov: Provenance, opts?: { readonly label?: string; readonly ctx?: CtxSnapshot; readonly ts?: string }): SetBookmarkResult {
    assertProvenance(prov, "setBookmark");
    const value: BookmarkFields = { prov, ctx: opts?.ctx ?? {}, ...(opts?.label !== undefined ? { label: opts.label } : {}) };
    const { record, superseded } = this.engine.set(target, value, opts?.ts);
    return { record: toBookmarkRecord(record), superseded: superseded ? toBookmarkRecord(superseded) : null };
  }

  revert(target: string, toTs?: string): BookmarkRecord | null {
    const r = this.engine.revert(target, toTs);
    return r ? toBookmarkRecord(r) : null;
  }
}
