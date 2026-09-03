// The generic revision engine — docs/specs/11-project-store.md §2.4/§7 step 1.
//
// Extracted from `src/name-overlay/store.ts`'s append-only supersession/revert
// machinery so every project-store record type (and the overlay itself) shares
// ONE engine: a new record for a slot key SUPERSEDES the prior active record
// (deactivated, never destroyed); `revert` re-activates a prior record (or
// clears the slot); the full history is always retrievable. Pure data, no I/O,
// no bytecode — same "unit-testable with no network" property the overlay's
// engine already had (spec §11.9 in the Design-D spec this generalizes).
//
// `RevisionStore<T>` knows nothing about what `T` means (a name, a tag, a
// comment, a finding) or how a slot key `target` is derived from a binding id
// — that mapping is the caller's job (`OverlayStore` maps `bindingKey(id)` to
// `target`; step 2's record modules will do the same for their own ids).

/** One revision of a value at `target` (the slot key). `rid` is this record's
 *  own id, referenced by a later record's `supersedes`; `active` is the
 *  currently-effective record for `target` (`revert` flips it without
 *  destroying history). */
export interface Revision<T> {
  readonly rid: string;
  readonly target: string;
  readonly value: T;
  readonly ts: string;
  readonly supersedes: string | null;
  readonly active: boolean;
}

export interface RevisionSetResult<T> {
  readonly record: Revision<T>;
  readonly superseded: Revision<T> | null;
}

export interface RevisionStoreInit<T> {
  readonly bundle?: string;
  readonly records?: readonly Revision<T>[];
  readonly seq?: number;
}

/** The append-only, slot-keyed revision engine. In-memory; callers own
 *  persistence (their on-disk shape is theirs to define — see spec §2.2). A
 *  slot's records form a supersession chain; at most one is `active`. */
export class RevisionStore<T> {
  private records: Revision<T>[];
  private seq: number;
  readonly bundle: string | undefined;
  /** Injectable clock — overridden in tests for deterministic timestamps. */
  now: () => string = () => new Date().toISOString();

  constructor(init?: RevisionStoreInit<T>) {
    this.records = init?.records ? [...init.records] : [];
    this.seq = init?.seq ?? this.records.length;
    this.bundle = init?.bundle;
  }

  /** Every record ever written, oldest first (the raw append log). */
  allRecords(): readonly Revision<T>[] {
    return this.records;
  }

  /** The engine's current sequence counter (the `rid` the next `set` will
   *  mint). Exposed so a caller persisting its own on-disk shape (e.g. the
   *  overlay's `.names.json`) can round-trip it exactly, even when it was
   *  initialised to something other than `records.length`. */
  currentSeq(): number {
    return this.seq;
  }

  /** The currently-active record for `target`, or `undefined` (an unset slot,
   *  or one reverted back to empty). */
  get(target: string): Revision<T> | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.active && r.target === target) return r;
    }
    return undefined;
  }

  /** The full supersession chain for `target`, newest first. */
  history(target: string): readonly Revision<T>[] {
    return this.records.filter((r) => r.target === target).slice().reverse();
  }

  /** Set `target`'s value. Append-only: any prior active record for the slot
   *  is superseded (deactivated, its `rid` recorded on the new one), never
   *  overwritten. `ts` defaults to `now()`. */
  set(target: string, value: T, ts?: string): RevisionSetResult<T> {
    const prior = this.get(target) ?? null;
    if (prior !== null) this.deactivate(prior.rid);
    const rid = String(this.seq++);
    const record: Revision<T> = {
      rid,
      target,
      value,
      ts: ts ?? this.now(),
      supersedes: prior?.rid ?? null,
      active: true,
    };
    this.records.push(record);
    return { record, superseded: prior };
  }

  /** Revert. With `toTs`, re-activate the record for `target` bearing that
   *  timestamp. Without it, re-activate the immediately-prior record in the
   *  chain; if none exists, clear the slot (no active record). Nothing is
   *  destroyed — a revert only flips `active`. Returns the now-active record,
   *  or `null` when cleared. */
  revert(target: string, toTs?: string): Revision<T> | null {
    const chain = this.records.filter((r) => r.target === target);
    if (chain.length === 0) return null;
    const current = chain.find((r) => r.active) ?? null;
    let next: Revision<T> | null;
    if (toTs !== undefined) {
      next = chain.find((r) => r.ts === toTs) ?? null;
      if (next === null) throw new Error(`revert: no record for ${target} at ts ${toTs}`);
    } else {
      // The record `current` superseded (its `supersedes` rid), else — when
      // `current` is the chain's first — clear the slot.
      next = current?.supersedes != null ? chain.find((r) => r.rid === current.supersedes) ?? null : null;
    }
    if (current !== null) this.deactivate(current.rid);
    if (next !== null) this.activate(next.rid);
    return next;
  }

  /** Filtered query over active records; caller supplies the predicate since
   *  `RevisionStore` doesn't know `T`'s shape. Empty result is empty, never an
   *  error. */
  search(pred: (r: Revision<T>) => boolean): readonly Revision<T>[] {
    return this.records.filter((r) => r.active && pred(r));
  }

  /** Mutate the active record for `target` in place via `updater` — no new
   *  revision, no `rid` bump. For advisory metadata that isn't itself a
   *  revision (e.g. the overlay's render-time collision flag); the caller
   *  decides whether the mutation is a no-op. */
  patchActive(target: string, updater: (value: T) => T): void {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.active && r.target === target) {
        this.records[i] = { ...r, value: updater(r.value) };
        return;
      }
    }
  }

  private deactivate(rid: string): void {
    const i = this.records.findIndex((r) => r.rid === rid);
    if (i >= 0) this.records[i] = { ...this.records[i]!, active: false };
  }

  private activate(rid: string): void {
    const i = this.records.findIndex((r) => r.rid === rid);
    if (i >= 0) this.records[i] = { ...this.records[i]!, active: true };
  }
}
