// The `tags` record type — docs/specs/11-project-store.md §1.3, §7 step 3.
//
// A thin consumer of `RevisionStore<T>` (step 1) over `TagRecord` (step 2's
// schema), same shape as `OverlayStore` wraps `RevisionStore<NameFields>` for
// names (`src/name-overlay/store.ts`). One difference from names: a target
// can carry several DIFFERENT tags at once (§1.3's taxonomy lists tags that
// naturally coexist, e.g. `source` + `reviewed`), so the append-only slot key
// is `(target, tag)` — §2.1's "(kind,target[,tag])" bracket — not `target`
// alone: setting `reviewed` never supersedes an active `source` tag on the
// same target, but setting `source` again on the same target supersedes the
// PRIOR `source` record for that target (append-only revision of the same
// assertion), leaving `history()` retrievable per (target, tag). The engine's
// own `target` field is this composite slot key; the RECORD's real `target`
// travels inside `value` (like `ctx`/`prov`) so it survives the round trip
// undistorted by the slot-key encoding.
import { RevisionStore } from "./revision-store.ts";
import type { Revision } from "./revision-store.ts";
import { assertProvenance, TAGS } from "./schema.ts";
import type { TagRecord, Tag, Provenance, CtxSnapshot } from "./schema.ts";

type TagFields = Pick<TagRecord, "target" | "tag" | "note" | "prov" | "ctx">;

export interface SetTagResult {
  readonly record: TagRecord;
  readonly superseded: TagRecord | null;
}

/** The slot key: target and tag both discriminate (see module header). Uses
 *  a space separator — safe because the id vocabulary (`fn:N`, `reg:F:R`,
 *  `sid:N`, `mod:N`) never contains one and `tag` is drawn from the closed
 *  `TAGS` enum. */
function slotKey(target: string, tag: string): string {
  return `${target} ${tag}`;
}

function toTagRecord(r: Revision<TagFields>): TagRecord {
  const { target, tag, note, prov, ctx } = r.value;
  return {
    rid: r.rid,
    kind: "tag",
    target,
    prov,
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
    ctx,
    tag,
    ...(note !== undefined ? { note } : {}),
  };
}

function toRevision(r: TagRecord): Revision<TagFields> {
  return {
    rid: r.rid,
    target: slotKey(r.target, r.tag),
    value: { target: r.target, tag: r.tag, prov: r.prov, ctx: r.ctx, ...(r.note !== undefined ? { note: r.note } : {}) },
    ts: r.ts,
    supersedes: r.supersedes,
    active: r.active,
  };
}

export class TagStore {
  private readonly engine: RevisionStore<TagFields>;

  constructor(init?: { readonly records?: readonly TagRecord[]; readonly seq?: number }) {
    this.engine = new RevisionStore<TagFields>({
      ...(init?.records ? { records: init.records.map(toRevision) } : {}),
      ...(init?.seq !== undefined ? { seq: init.seq } : {}),
    });
  }

  /** Injectable clock, same discipline as `RevisionStore`/`OverlayStore`. */
  set now(fn: () => string) {
    this.engine.now = fn;
  }

  /** Every record ever written, oldest first — what a caller persists back
   *  through `io.ts`'s `saveRecordFile("tags", …)`. */
  allRecords(): readonly TagRecord[] {
    return this.engine.allRecords().map(toTagRecord);
  }

  /** Every currently-active tag on `target` (§1.3: several may coexist). */
  getTags(target: string): readonly TagRecord[] {
    return this.engine
      .allRecords()
      .filter((r) => r.active && r.value.target === target)
      .map(toTagRecord);
  }

  /** The full supersession chain for one `(target, tag)` slot, newest first. */
  history(target: string, tag: Tag): readonly TagRecord[] {
    return this.engine.history(slotKey(target, tag)).map(toTagRecord);
  }

  /** Assert `tag` on `target` (§1.3/§4.2). Append-only per `(target, tag)`
   *  slot (module header); rejects an unknown tag or a missing/malformed
   *  `prov` (§4.2 — "not writable" without provenance) BEFORE minting a
   *  record, mirroring `assertEnvelope`'s on-disk validation for writes that
   *  never touch disk. */
  setTag(target: string, tag: Tag, prov: Provenance, opts?: { readonly note?: string; readonly ctx?: CtxSnapshot; readonly ts?: string }): SetTagResult {
    if (!TAGS.includes(tag)) throw new Error(`setTag: unknown tag ${JSON.stringify(tag)}, not in the v1 taxonomy (spec 11 §1.3)`);
    assertProvenance(prov, "setTag");
    const value: TagFields = { target, tag, prov, ctx: opts?.ctx ?? {}, ...(opts?.note !== undefined ? { note: opts.note } : {}) };
    const { record, superseded } = this.engine.set(slotKey(target, tag), value, opts?.ts);
    return { record: toTagRecord(record), superseded: superseded ? toTagRecord(superseded) : null };
  }

  /** Revert `(target, tag)` to its prior value (or clear the slot). Nothing
   *  destroyed — append-only holds (§2.1). */
  revert(target: string, tag: Tag, toTs?: string): TagRecord | null {
    const r = this.engine.revert(slotKey(target, tag), toTs);
    return r ? toTagRecord(r) : null;
  }
}
