// The `comments` record type — docs/specs/11-project-store.md §1.2, §7 step 3.
//
// Two granularities share one file (§1.2): an fn-level note (`{target}`) and
// a site-level note pinned to a rendered line (`{target, range}`). Each is
// its own append-only slot — §2.1's "(kind,target[,tag])" bracket, read here
// as "[,range]" — so writing a NEW site comment at a different line never
// supersedes an existing one, while re-commenting the SAME fn (no range) or
// the SAME line revises that slot's prior note (append-only, not a stack of
// unrelated duplicates). §9 ruling 2: a moved/missing range degrades to
// `rangeStale: true` rather than being dropped; the live re-anchor check
// against `ranges.jsonl` is a later step's job (needs the warm artifact
// index, §3.3) — this module only carries the flag through the envelope.
import { RevisionStore } from "./revision-store.ts";
import type { Revision } from "./revision-store.ts";
import { assertProvenance } from "./schema.ts";
import type { CommentRecord, CommentRange, Provenance, CtxSnapshot } from "./schema.ts";

type CommentFields = Pick<CommentRecord, "target" | "body" | "range" | "rangeStale" | "prov" | "ctx">;

export interface AddCommentResult {
  readonly record: CommentRecord;
  readonly superseded: CommentRecord | null;
}

function rangeKey(range: CommentRange | undefined): string {
  if (range === undefined) return "";
  return range.col !== undefined ? `:${range.line}:${range.col}` : `:${range.line}`;
}

function slotKey(target: string, range: CommentRange | undefined): string {
  return `${target}${rangeKey(range)}`;
}

function toCommentRecord(r: Revision<CommentFields>): CommentRecord {
  const { target, body, range, rangeStale, prov, ctx } = r.value;
  return {
    rid: r.rid,
    kind: "comment",
    target,
    prov,
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx,
    body,
    ...(range !== undefined ? { range } : {}),
    ...(rangeStale !== undefined ? { rangeStale } : {}),
  };
}

function toRevision(r: CommentRecord): Revision<CommentFields> {
  return {
    rid: r.rid,
    target: slotKey(r.target, r.range),
    value: {
      target: r.target,
      body: r.body,
      prov: r.prov,
      ctx: r.ctx,
      ...(r.range !== undefined ? { range: r.range } : {}),
      ...(r.rangeStale !== undefined ? { rangeStale: r.rangeStale } : {}),
    },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

export class CommentStore {
  private readonly engine: RevisionStore<CommentFields>;

  constructor(init?: { readonly records?: readonly CommentRecord[]; readonly seq?: number }) {
    this.engine = new RevisionStore<CommentFields>({
      ...(init?.records ? { records: init.records.map(toRevision) } : {}),
      ...(init?.seq !== undefined ? { seq: init.seq } : {}),
    });
  }

  set now(fn: () => string) {
    this.engine.now = fn;
  }

  allRecords(): readonly CommentRecord[] {
    return this.engine.allRecords().map(toCommentRecord);
  }

  /** Every active comment (fn-level and site-level) targeting fn `target`
   *  (i.e. `target === "fn:N"`), what `project comments <fn>` (§3.1) reads. */
  forTarget(target: string): readonly CommentRecord[] {
    return this.engine
      .allRecords()
      .filter((r) => r.active && r.value.target === target)
      .map(toCommentRecord);
  }

  history(target: string, range?: CommentRange): readonly CommentRecord[] {
    return this.engine.history(slotKey(target, range)).map(toCommentRecord);
  }

  /** Add/revise a comment (§1.2/§4.2). Pure prose — no evidence requirement
   *  (§1.2), unlike findings — but `prov` is still mandatory (§4.2). */
  addComment(
    target: string,
    body: string,
    prov: Provenance,
    opts?: { readonly range?: CommentRange; readonly rangeStale?: boolean; readonly ctx?: CtxSnapshot; readonly ts?: string },
  ): AddCommentResult {
    assertProvenance(prov, "addComment");
    const value: CommentFields = {
      target,
      body,
      prov,
      ctx: opts?.ctx ?? {},
      ...(opts?.range !== undefined ? { range: opts.range } : {}),
      ...(opts?.rangeStale !== undefined ? { rangeStale: opts.rangeStale } : {}),
    };
    const { record, superseded } = this.engine.set(slotKey(target, opts?.range), value, opts?.ts);
    return { record: toCommentRecord(record), superseded: superseded ? toCommentRecord(superseded) : null };
  }

  revert(target: string, range?: CommentRange, toTs?: string): CommentRecord | null {
    const r = this.engine.revert(slotKey(target, range), toTs);
    return r ? toCommentRecord(r) : null;
  }
}
