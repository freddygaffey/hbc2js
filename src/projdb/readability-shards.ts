// src/projdb/readability-shards.ts -- the `analysis/readability/<id>.json`
// shard family (docs/specs/28-llm-readability.md section 9.5, layered on
// docs/specs/18-project-storage-integrity.md sections 3-8).
//
// This module is the projdb-side half of the readability transaction log: the
// row<->transaction mapping, the shard CONTENT (never the write -- `export.ts`
// owns `writeShard` and the hash lock), the log-tail entries, and the
// shards->DB restore `rebuild.ts` needs. `src/readability/transactions.ts` is
// the caller-facing API and depends on this file, not the other way round, so
// there is no cycle between `src/readability` and `src/projdb`.
//
// Nothing new is invented about integrity. The shard hash, the `stateBinding`
// and the `log/` chain are spec 18's, unchanged; this family only adds rows to
// them.
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { BindingOrigin, EmittedFile, EquivProof, ReadabilityTransaction, TransactionOp } from "../readability/types.ts";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** One `readability_tx` row, JSON columns already parsed. */
export interface ReadabilityTxRow {
  readonly seq: number;
  readonly tx: ReadabilityTransaction;
  /** The tx id this row reverts, or `undefined` for a forward change. */
  readonly reverts?: string;
}

interface RawRow {
  readonly seq: number;
  readonly id: string;
  readonly op: string;
  readonly who: string;
  readonly tier: string;
  readonly ts: string;
  readonly inputs: string;
  readonly outputs: string;
  readonly equiv: string;
  readonly evidence: string;
  readonly prior: string;
  readonly reverts: string | null;
}

function parseRow(r: RawRow): ReadabilityTxRow {
  const tx: ReadabilityTransaction = {
    id: r.id,
    op: r.op as TransactionOp,
    who: r.who,
    tier: r.tier as "suggested" | "confirmed",
    ts: r.ts,
    inputs: JSON.parse(r.inputs) as BindingOrigin[],
    outputs: JSON.parse(r.outputs) as EmittedFile[],
    equiv: JSON.parse(r.equiv) as EquivProof,
    evidence: r.evidence,
    prior: JSON.parse(r.prior) as { files: { path: string; sha256: string }[] },
  };
  return r.reverts === null ? { seq: r.seq, tx } : { seq: r.seq, tx, reverts: r.reverts };
}

const SELECT_COLS = `seq, id, op, who, tier, ts, inputs, outputs, equiv, evidence, prior, reverts`;

/** Whether this DB is at schema minor 6 or later. A pre-migration DB simply
 *  has no readability transactions, which is not an error anywhere: export,
 *  rebuild and verify all treat "table absent" as "zero rows" (the same way
 *  `seg-cache.ts` treats its own pre-migration DB). */
export function hasReadabilityTable(db: DatabaseSync): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'readability_tx'`).get() as { name: string } | undefined;
  return row !== undefined;
}

/** Every transaction, in insertion order -- which is also log-tail order and
 *  revert order. */
export function readTransactionRows(db: DatabaseSync): ReadabilityTxRow[] {
  if (!hasReadabilityTable(db)) return [];
  const rows = db.prepare(`SELECT ${SELECT_COLS} FROM readability_tx ORDER BY seq`).all() as unknown as RawRow[];
  return rows.map(parseRow);
}

export function readTransactionRow(db: DatabaseSync, id: string): ReadabilityTxRow | undefined {
  if (!hasReadabilityTable(db)) return undefined;
  const row = db.prepare(`SELECT ${SELECT_COLS} FROM readability_tx WHERE id = ?`).get(id) as unknown as RawRow | undefined;
  return row === undefined ? undefined : parseRow(row);
}

export function readBlob(db: DatabaseSync, sha256: string): string | undefined {
  if (!hasReadabilityTable(db)) return undefined;
  const row = db.prepare(`SELECT content FROM readability_blob WHERE sha256 = ?`).get(sha256) as { content: string } | undefined;
  return row?.content;
}

/** The shard content for one transaction. Carries the transaction verbatim
 *  plus the `blobs` its `prior` hashes name, so the JSON side is a COMPLETE
 *  recovery source: `rebuild` can restore the table and every byte a revert
 *  would put back, without the DB (spec 18 section R4's recovery direction).
 *  Blobs are inlined because a readability tree is source text and the whole
 *  family is git-tracked; externalising them for very large trees is a noted
 *  follow-up in spec 28 section 9.5, not an integrity question. */
export function transactionShardContent(db: DatabaseSync, row: ReadabilityTxRow): Record<string, unknown> {
  const blobs: Record<string, string> = {};
  for (const f of row.tx.prior.files) {
    const content = readBlob(db, f.sha256);
    if (content !== undefined) blobs[f.sha256] = content;
  }
  return {
    shard: `readability/${row.tx.id}`,
    id: row.tx.id,
    seq: row.seq,
    op: row.tx.op,
    who: row.tx.who,
    tier: row.tx.tier,
    ts: row.tx.ts,
    inputs: row.tx.inputs,
    outputs: row.tx.outputs,
    equiv: row.tx.equiv,
    evidence: row.tx.evidence,
    prior: row.tx.prior,
    ...(row.reverts !== undefined ? { reverts: row.reverts } : {}),
    blobs,
  };
}

/** Inserts one transaction (and the blobs its `prior` needs) in the CALLER's
 *  open SQLite transaction -- spec 18 section 6 step 2, DB first. Never
 *  exports and never touches the log; `src/readability/transactions.ts` runs
 *  the three steps in order. */
export function insertTransactionRow(
  db: DatabaseSync,
  tx: ReadabilityTransaction,
  blobs: ReadonlyMap<string, string>,
  reverts?: string,
): void {
  const insBlob = db.prepare(`INSERT INTO readability_blob (sha256, content) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING`);
  for (const [sha, content] of blobs) insBlob.run(sha, content);
  db.prepare(
    `INSERT INTO readability_tx (id, op, who, tier, ts, inputs, outputs, equiv, evidence, prior, reverts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tx.id,
    tx.op,
    tx.who,
    tx.tier,
    tx.ts,
    JSON.stringify(tx.inputs),
    JSON.stringify(tx.outputs),
    JSON.stringify(tx.equiv),
    tx.evidence,
    JSON.stringify(tx.prior),
    reverts ?? null,
  );
}

/** JSON -> DB, for `rebuildProject`. Restores every `readability_tx` row and
 *  every blob from the shard family so a rebuilt DB re-exports the same
 *  shards byte for byte (spec 18 section R3 metric 1). `seq` is restored from
 *  the shard, so log-tail order survives the round trip. */
export function restoreTransactionShard(db: DatabaseSync, shard: Record<string, unknown>): boolean {
  const id = shard.id;
  if (typeof id !== "string") return false;
  const blobs = (shard.blobs ?? {}) as Record<string, string>;
  const insBlob = db.prepare(`INSERT INTO readability_blob (sha256, content) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING`);
  for (const [sha, content] of Object.entries(blobs)) if (typeof content === "string") insBlob.run(sha, content);
  db.prepare(
    `INSERT INTO readability_tx (seq, id, op, who, tier, ts, inputs, outputs, equiv, evidence, prior, reverts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(
    typeof shard.seq === "number" ? shard.seq : null,
    id,
    String(shard.op),
    String(shard.who),
    String(shard.tier),
    String(shard.ts),
    JSON.stringify(shard.inputs ?? []),
    JSON.stringify(shard.outputs ?? []),
    JSON.stringify(shard.equiv ?? {}),
    String(shard.evidence ?? ""),
    JSON.stringify(shard.prior ?? { files: [] }),
    typeof shard.reverts === "string" ? shard.reverts : null,
  );
  return true;
}

/** The `log/<date>.jsonl` entry for one transaction, minus the chain fields
 *  (`prevHash`/`hash`), which the log writer adds. Same envelope shape the
 *  annotation entries use: `seq`, `ts`, `op`, `actor`, `kind`, `target`,
 *  `rid`, `shards`. */
export function readabilityLogEntry(row: ReadabilityTxRow, shardHash: string | undefined): Record<string, unknown> {
  return {
    seq: row.seq,
    ts: row.tx.ts,
    op: "readability",
    actor: { source: row.tx.who.startsWith("worker:") ? "llm" : "human", who: row.tx.who },
    kind: "readability-tx",
    target: row.tx.id,
    txOp: row.tx.op,
    tier: row.tx.tier,
    rid: row.tx.id,
    shards: shardHash === undefined ? [] : [{ path: `readability/${row.tx.id}`, contentHash: shardHash }],
    ...(row.reverts !== undefined ? { reverts: row.reverts } : {}),
  };
}
