// src/projdb/revision-store.ts — the annotation stratum's DB-backed revision
// engine (docs/specs/16-project-db.md §2.3, §8 step 3). Transcribes
// `src/project/revision-store.ts`'s (the JSONL engine's) slot/rid/supersede
// semantics onto the `.hbcproj` `revisions` (+ per-kind `d_*` detail) table,
// with `active` a DERIVED notion (the `v_active` view, schema.sql §2.3) —
// stored rows are immutable; a revert appends a new `revisions` row instead
// of flipping an `active` flag in place. `readActive` follows the SAME
// indirection the schema's own comment on `v_active` names: "the payload rid
// resolves via `reactivates` when set; readers join the appropriate `d_*`
// table on `payload_rid`" — so a revert never has to duplicate a detail row,
// only bookkeeping is appended.
//
// Every write (`set`/`revert`) also appends one `log` row in the SAME
// transaction (op='annotate'|'revert', `rid` = the new `revisions.rid`) —
// the A3 invariant (docs/specs/16-project-db.md §7): every `revisions.rid`
// appears exactly once in `log`.
//
// `tests/projdb/revision-equiv.test.ts` (A4) replays the same scripted
// write/supersede/revert/clear sequence against this engine and against
// `RevisionStore` and asserts identical active-slot outcomes and identical
// per-slot value timelines — the guard that this derivation is genuinely
// `RevisionStore`'s semantics, not a re-interpretation.
import type { DatabaseSync } from "node:sqlite";

/** The `revisions.kind` enum (schema.sql §2.3). */
export type RevisionKind = "name" | "comment" | "tag" | "bookmark" | "finding" | "status" | "conflict";

export interface DbProvenance {
  readonly source: "human" | "llm" | "tool";
  readonly who: string;
  readonly run?: string | null;
  /** docs/specs/17-mcp-harness.md §15 (spec 23 §4's follow-up): defaults to
   *  `"accepted"` wherever omitted — every pre-this-round writer, and every
   *  caller that still doesn't pass one, behaves exactly as before. Stored in
   *  the MIGRATION 3 `revision_tier` side table (`set()`/`readTier` below),
   *  never a column on `revisions` itself (see schema.sql's MIGRATION 3
   *  header for why: no idempotent in-place `ALTER TABLE ADD COLUMN` in this
   *  sqlite build). */
  readonly tier?: "suggested" | "accepted" | null;
}

export interface DbCtxSnapshot {
  readonly name?: string | null;
  readonly loc?: string | null;
  readonly ownerFn?: string | null;
}

/** One revision as read back from the DB — same shape as
 *  `src/project/revision-store.ts`'s `Revision<T>` (rid/target/value/ts/
 *  supersedes/active), so the equivalence test can compare the two engines'
 *  outputs field-for-field. `target` here is the SLOT key the caller passed
 *  to `set`/`get`/`history`/`revert` (mirrors the in-memory engine, where
 *  `target` IS the slot key — composite keys, e.g. tags' `(target, tag)`,
 *  are the write-verb layer's job, exactly as `TagStore` composes one on top
 *  of `RevisionStore`, see `src/projdb/annotations.ts`). */
export interface DbRevision<T> {
  readonly rid: string;
  readonly target: string;
  readonly value: T;
  readonly ts: string;
  readonly supersedes: string | null;
  readonly active: boolean;
  readonly ctx: DbCtxSnapshot;
  readonly prov: DbProvenance;
}

export interface DbRevisionSetResult<T> {
  readonly record: DbRevision<T>;
  readonly superseded: DbRevision<T> | null;
}

/** The per-kind detail-table read/write boundary — the only place a caller
 *  names its own `d_<kind>` columns. `writeDetail` is called once per fresh
 *  `revisions` row minted by `set` (never by `revert`, which appends
 *  bookkeeping only — see module header). */
export interface DetailAdapter<T> {
  readonly kind: RevisionKind;
  writeDetail(db: DatabaseSync, rid: number, value: T): void;
  readDetail(db: DatabaseSync, rid: number): T;
}

interface ActiveRow {
  readonly headRid: number;
  readonly payloadRid: number;
  readonly target: string;
}

interface RevisionRow {
  readonly rid: number;
  readonly target: string;
  readonly ts: string;
  readonly supersedes: number | null;
  readonly ctxName: string | null;
  readonly ctxLoc: string | null;
  readonly ctxOwner: string | null;
  readonly provSource: "human" | "llm" | "tool";
  readonly provWho: string;
  readonly provRun: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRevisionId(rid: number | null): string | null {
  return rid === null ? null : String(rid);
}

/** The DB-backed counterpart of `src/project/revision-store.ts`'s
 *  `RevisionStore<T>`. One instance is scoped to a single `kind` (its
 *  `DetailAdapter`); the write-verb layer (`annotations.ts`) owns mapping a
 *  record's real `target` + any extra discriminator (a tag, a `patternId`)
 *  into the single `slot` string this engine treats as opaque, exactly as
 *  `TagStore` does on top of the in-memory engine. */
export class DbRevisionStore<T> {
  private readonly db: DatabaseSync;
  private readonly adapter: DetailAdapter<T>;

  constructor(db: DatabaseSync, adapter: DetailAdapter<T>) {
    this.db = db;
    this.adapter = adapter;
  }

  /** The currently-active record for `slot`, or `undefined` (an unset slot,
   *  or one reverted back to empty) — reads through `v_active`, resolving
   *  `reactivates` per the schema's own note (module header). */
  get(slot: string): DbRevision<T> | undefined {
    const active = this.activeRow(slot);
    if (active === undefined) return undefined;
    return this.toDbRevision(active.payloadRid, true);
  }

  /** The full supersession chain for `slot`, newest first — every
   *  content-bearing row (`set`-minted, never a `revert` bookkeeping row,
   *  which carries no detail of its own — see module header), each with its
   *  currently-derived `active` flag. */
  history(slot: string): readonly DbRevision<T>[] {
    const active = this.activeRow(slot);
    const rows = this.db
      .prepare(
        `SELECT rid, target, ts, supersedes, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions
          WHERE slot = ? AND kind = ? AND reactivates IS NULL AND cleared = 0
          ORDER BY rid DESC`,
      )
      .all(slot, this.adapter.kind) as unknown as RevisionRow[];
    return rows.map((r) => this.rowToDbRevision(r, active !== undefined && active.payloadRid === r.rid));
  }

  /** Every content-bearing record ever written for this kind, oldest first —
   *  the DB counterpart of `RevisionStore.allRecords()`. */
  allRecords(): readonly DbRevision<T>[] {
    const rows = this.db
      .prepare(
        `SELECT rid, target, ts, supersedes, slot, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions
          WHERE kind = ? AND reactivates IS NULL AND cleared = 0
          ORDER BY rid ASC`,
      )
      .all(this.adapter.kind) as unknown as (RevisionRow & { slot: string })[];
    return rows.map((r) => {
      const active = this.activeRow(r.slot);
      return this.rowToDbRevision(r, active !== undefined && active.payloadRid === r.rid);
    });
  }

  /** Set `slot`'s value. Append-only: mints a fresh `revisions` row whose
   *  `supersedes` names the prior active record's rid (or `null`), writes
   *  its detail row, and appends one `log` row (`op='annotate'`) in the same
   *  transaction. `target` is the record's real id (schema.sql's
   *  `revisions.target` column, distinct from `slot`, its `slot` column). */
  set(
    slot: string,
    target: string,
    value: T,
    prov: DbProvenance,
    opts?: { readonly ts?: string; readonly ctx?: DbCtxSnapshot },
  ): DbRevisionSetResult<T> {
    const prior = this.activeRow(slot);
    const priorRecord = prior === undefined ? null : this.toDbRevision(prior.payloadRid, true);
    const ts = opts?.ts ?? nowIso();
    const ctx = opts?.ctx;
    const db = this.db;
    db.exec("BEGIN;");
    try {
      const ins = db.prepare(
        `INSERT INTO revisions
           (kind, target, slot, prov_source, prov_who, prov_run, ts,
            supersedes, reactivates, cleared, ctx_name, ctx_loc, ctx_owner, legacy_rid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL)`,
      );
      const info = ins.run(
        this.adapter.kind,
        target,
        slot,
        prov.source,
        prov.who,
        prov.run ?? null,
        ts,
        prior === undefined ? null : prior.payloadRid,
        ctx?.name ?? null,
        ctx?.loc ?? null,
        ctx?.ownerFn ?? null,
      );
      const rid = Number(info.lastInsertRowid);
      this.adapter.writeDetail(db, rid, value);
      const tier = prov.tier ?? "accepted";
      db.prepare(`INSERT INTO revision_tier (rid, tier) VALUES (?, ?)`).run(rid, tier);
      this.appendLog(prov, ts, "annotate", rid, target);
      db.exec("COMMIT;");
      const provOut: DbProvenance = { ...prov, tier };
      const record: DbRevision<T> = { rid: String(rid), target, value, ts, supersedes: toRevisionId(prior === undefined ? null : prior.payloadRid), active: true, ctx: ctx ?? {}, prov: provOut };
      return { record, superseded: priorRecord };
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  /** Revert `slot`. With `toTs`, re-activate the content-bearing record
   *  whose `ts` matches (throws if none). Without it, re-activate the
   *  record the current active one superseded, or clear the slot if there
   *  is none. A true no-op (nothing currently active AND nothing to
   *  reactivate) writes nothing — matches `RevisionStore.revert`'s
   *  behaviour exactly. Otherwise appends one bookkeeping `revisions` row
   *  (`reactivates` set, or `cleared=1`) + one `log` row (`op='revert'`). */
  revert(slot: string, prov: DbProvenance, toTs?: string): DbRevision<T> | null {
    const current = this.activeRow(slot);
    let next: RevisionRow | null;
    if (toTs !== undefined) {
      const row = this.db
        .prepare(
          `SELECT rid, target, ts, supersedes, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions
            WHERE slot = ? AND kind = ? AND reactivates IS NULL AND cleared = 0 AND ts = ?`,
        )
        .get(slot, this.adapter.kind, toTs) as unknown as RevisionRow | undefined;
      if (row === undefined) throw new Error(`revert: no record for ${slot} at ts ${toTs}`);
      next = row;
    } else if (current !== undefined) {
      const currentRow = this.db
        .prepare(`SELECT rid, target, ts, supersedes, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions WHERE rid = ?`)
        .get(current.payloadRid) as unknown as RevisionRow;
      next =
        currentRow.supersedes !== null
          ? ((this.db.prepare(`SELECT rid, target, ts, supersedes, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions WHERE rid = ?`).get(currentRow.supersedes) as unknown as
              | RevisionRow
              | undefined) ?? null)
          : null;
    } else {
      next = null;
    }

    if (current === undefined && next === null) return null; // true no-op

    const ts = nowIso();
    const target = current?.target ?? next?.target ?? "";
    const db = this.db;
    db.exec("BEGIN;");
    try {
      const ins = db.prepare(
        `INSERT INTO revisions
           (kind, target, slot, prov_source, prov_who, prov_run, ts,
            supersedes, reactivates, cleared, ctx_name, ctx_loc, ctx_owner, legacy_rid)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
      );
      const info = ins.run(
        this.adapter.kind,
        target,
        slot,
        prov.source,
        prov.who,
        prov.run ?? null,
        ts,
        next === null ? null : next.rid,
        next === null ? 1 : 0,
      );
      const rid = Number(info.lastInsertRowid);
      this.appendLog(prov, ts, "revert", rid, target);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }

    if (next === null) return null;
    return this.rowToDbRevision(next, true);
  }

  /** `target` rides along in `detail` (additive: existing readers only ever
   *  looked at `.kind`, spec 21 §1.3's live-update doorbell is the first
   *  reader of `.target` — `src/ui-server/routes.ts`'s `tailLog` parses it
   *  back out to build the SSE frame's `targets: string[]`, spec 26 L1). No
   *  schema change: `revisions.target` already carries this per-rid, this
   *  just spares a join for a reader that only has the log table's own
   *  `detail` column to work with. */
  private appendLog(prov: DbProvenance, ts: string, op: "annotate" | "revert", rid: number, target: string): void {
    this.db
      .prepare(
        `INSERT INTO log (ts, actor_source, actor_who, actor_run, op, rid, gen, detail)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(ts, prov.source, prov.who, prov.run ?? null, op, rid, JSON.stringify({ kind: this.adapter.kind, target }));
  }

  /** `v_active` joined back to `revisions` on `head_rid` to recover `slot`
   *  (the view itself does not expose it — see schema.sql §2.3). */
  private activeRow(slot: string): ActiveRow | undefined {
    const row = this.db
      .prepare(
        `SELECT v.head_rid AS headRid, v.payload_rid AS payloadRid, v.target AS target
           FROM v_active v JOIN revisions r ON r.rid = v.head_rid
          WHERE r.slot = ? AND v.kind = ?`,
      )
      .get(slot, this.adapter.kind) as unknown as { headRid: number; payloadRid: number; target: string } | undefined;
    if (row === undefined) return undefined;
    return { headRid: row.headRid, payloadRid: row.payloadRid, target: row.target };
  }

  /** MIGRATION 3's `revision_tier` side table (module header + `set()`): no
   *  row means the `rid` predates the tier follow-up, or was written by a
   *  caller that never named one — `'accepted'` either way (default,
   *  backwards compatible). */
  private readTier(rid: number): "suggested" | "accepted" {
    const row = this.db.prepare(`SELECT tier FROM revision_tier WHERE rid = ?`).get(rid) as unknown as { tier: "suggested" | "accepted" } | undefined;
    return row?.tier ?? "accepted";
  }

  private toDbRevision(rid: number, active: boolean): DbRevision<T> {
    const row = this.db.prepare(`SELECT rid, target, ts, supersedes, ctx_name AS ctxName, ctx_loc AS ctxLoc, ctx_owner AS ctxOwner, prov_source AS provSource, prov_who AS provWho, prov_run AS provRun FROM revisions WHERE rid = ?`).get(rid) as unknown as RevisionRow;
    return this.rowToDbRevision(row, active);
  }

  private rowToDbRevision(row: RevisionRow, active: boolean): DbRevision<T> {
    const value = this.adapter.readDetail(this.db, row.rid);
    const ctx: DbCtxSnapshot = {
      ...(row.ctxName !== null ? { name: row.ctxName } : {}),
      ...(row.ctxLoc !== null ? { loc: row.ctxLoc } : {}),
      ...(row.ctxOwner !== null ? { ownerFn: row.ctxOwner } : {}),
    };
    const prov: DbProvenance = { source: row.provSource, who: row.provWho, ...(row.provRun !== null ? { run: row.provRun } : {}), tier: this.readTier(row.rid) };
    return {
      rid: String(row.rid),
      target: row.target,
      value,
      ts: row.ts,
      supersedes: toRevisionId(row.supersedes),
      active,
      ctx,
      prov,
    };
  }
}
