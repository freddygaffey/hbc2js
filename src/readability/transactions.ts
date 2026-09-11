// src/readability/transactions.ts -- the readability transaction log
// (docs/specs/28-llm-readability.md sections 1c, 9.5), layered on spec 18's
// storage integrity model without changing any of it.
//
// The write order is spec 18 section 6's, unchanged:
//   1. DB first, in ONE SQLite transaction (`commitTransaction`)
//   2. then the `analysis/readability/<id>.json` shard
//   3. then the hash-chained `log/<date>.jsonl` entry
// Steps 2 and 3 are `exportProject`'s, called after the commit, so a crash
// between 1 and 2 leaves the DB authoritative and a plain re-export (or
// `hbcproj export`) completes the write -- nothing is lost and nothing is
// half-written, which is what `recordTransaction`'s crash test proves.
//
// Refusal comes BEFORE any of that: `validateTransaction` (zero-origin
// output, missing inputs, missing prior state, non-PASS proof, worker
// self-promotion) is checked first, and a refused transaction writes nothing
// at all -- not the DB, not a shard, not a log line.
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportProject } from "../projdb/export.ts";
import {
  insertTransactionRow,
  readBlob,
  readTransactionRow,
  readTransactionRows,
  sha256Hex,
} from "../projdb/readability-shards.ts";
import type { ReadabilityTxRow } from "../projdb/readability-shards.ts";
import { validateTransaction } from "./types.ts";
import type { BindingOrigin, EmittedFile, ReadabilityTransaction, TransactionOp, TransactionProblem } from "./types.ts";

export type { ReadabilityTxRow };

/** A transaction the log refused. Carries the structural problems so a caller
 *  can report exactly why; nothing was written when this is thrown. */
export class TransactionRefused extends Error {
  readonly problems: readonly TransactionProblem[];
  constructor(message: string, problems: readonly TransactionProblem[]) {
    super(message);
    this.name = "TransactionRefused";
    this.problems = problems;
  }
}

/** Spec 18 section 7's allocation rule: the id is a content hash of the
 *  IMMUTABLE defining fields, so proposing the same op over the same inputs
 *  with the same evidence dedups for free. `who`, `tier` and `ts` are
 *  deliberately absent -- they are provenance, not identity. */
export function transactionId(op: TransactionOp, inputs: readonly BindingOrigin[], outputs: readonly EmittedFile[], evidence: string): string {
  return sha256Hex(
    JSON.stringify([
      op,
      inputs.map((i) => [i.module, i.binding ?? null]),
      outputs.map((o) => [o.path, o.origins.map((i) => [i.module, i.binding ?? null])]),
      evidence,
    ]),
  );
}

export function sha256(text: string): string {
  return sha256Hex(text);
}

export interface RecordOptions {
  /** The exact bytes of every `prior` path, keyed by path. A transaction
   *  whose prior state is not supplied is REFUSED: without the content the
   *  DB cannot honour the byte-for-byte revert guarantee, so recording it
   *  would make the log lie. */
  readonly priorContents?: ReadonlyMap<string, string>;
  /** The transaction this one reverts, for a revert entry. */
  readonly reverts?: string;
}

function priorBlobs(tx: ReadabilityTransaction, opts: RecordOptions | undefined): Map<string, string> {
  const blobs = new Map<string, string>();
  const problems: TransactionProblem[] = [];
  for (const f of tx.prior.files) {
    const content = opts?.priorContents?.get(f.path);
    if (content === undefined) {
      problems.push({ code: "not-reversible", detail: `${tx.id}: no content supplied for prior path ${f.path}` });
      continue;
    }
    const actual = sha256Hex(content);
    if (actual !== f.sha256) {
      problems.push({ code: "not-reversible", detail: `${tx.id}: prior content for ${f.path} hashes to ${actual}, not the recorded ${f.sha256}` });
      continue;
    }
    blobs.set(f.sha256, content);
  }
  if (problems.length > 0) throw new TransactionRefused(`transaction ${tx.id} refused: ${problems.map((p) => p.detail).join("; ")}`, problems);
  return blobs;
}

/** Step 1 only: validate, then commit the row + its blobs to the DB in ONE
 *  SQLite transaction. Exposed separately from `recordTransaction` so the
 *  crash-between-commit-and-export case is testable, and so a caller batching
 *  several transactions can export once. */
export function commitTransaction(db: DatabaseSync, tx: ReadabilityTransaction, opts?: RecordOptions): void {
  const problems = validateTransaction(tx);
  if (problems.length > 0) {
    throw new TransactionRefused(`transaction ${tx.id} refused: ${problems.map((p) => p.detail).join("; ")}`, problems);
  }
  if (readTransactionRow(db, tx.id) !== undefined) {
    throw new TransactionRefused(`transaction ${tx.id} is already recorded (content-hash dedup, spec 18 section 7)`, []);
  }
  const blobs = priorBlobs(tx, opts);
  db.exec("BEGIN;");
  try {
    insertTransactionRow(db, tx, blobs, opts?.reverts);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export interface RecordResult {
  readonly id: string;
  /** Shard + log paths the export step wrote. */
  readonly written: readonly string[];
}

/** The full spec 18 section 6 write: DB, then shard, then log. */
export function recordTransaction(db: DatabaseSync, projectDir: string, tx: ReadabilityTransaction, opts?: RecordOptions): RecordResult {
  commitTransaction(db, tx, opts);
  const result = exportProject(db, projectDir);
  return { id: tx.id, written: result.written };
}

export function listTransactions(db: DatabaseSync): readonly ReadabilityTxRow[] {
  return readTransactionRows(db);
}

export function getTransaction(db: DatabaseSync, id: string): ReadabilityTxRow | undefined {
  return readTransactionRow(db, id);
}

// ---------------------------------------------------------------------------
// Revert (spec 28 section 9.5's reversibility guarantee)
// ---------------------------------------------------------------------------

export interface RevertResult {
  readonly txId: string;
  /** The id of the revert transaction itself -- a revert is auditable. */
  readonly revertTxId: string;
  /** Every path put back, with the sha256 it was restored to. */
  readonly restored: readonly { readonly path: string; readonly sha256: string }[];
  /** Every path the reverted transaction had created and that is now gone. */
  readonly removed: readonly string[];
}

/** Reverts `txId`: every `prior` path goes back to exactly the sha256 the
 *  transaction recorded, from DB-held content, and every path the
 *  transaction created that had no prior state is removed. The revert is
 *  itself a transaction (so it is auditable, and reverting IT redoes the
 *  original), and it carries the original's own proof by reference: it
 *  restores a tree state the oracle already passed.
 *
 *  Refuses when the transaction is unknown, already reverted, or when a blob
 *  it needs is missing -- a revert that cannot be exact never half-happens. */
export function revertTransaction(db: DatabaseSync, projectDir: string, treeDir: string, txId: string, who: string, now?: string): RevertResult {
  const row = readTransactionRow(db, txId);
  if (row === undefined) throw new TransactionRefused(`revert: no transaction ${txId}`, []);
  for (const other of readTransactionRows(db)) {
    if (other.reverts === txId) throw new TransactionRefused(`revert: transaction ${txId} was already reverted by ${other.tx.id}`, []);
  }

  // Resolve every byte BEFORE touching the tree.
  const restore: { path: string; sha256: string; content: string }[] = [];
  for (const f of row.tx.prior.files) {
    const content = readBlob(db, f.sha256);
    if (content === undefined) throw new TransactionRefused(`revert: the DB holds no content for ${f.path} (${f.sha256})`, []);
    restore.push({ path: f.path, sha256: f.sha256, content });
  }
  const priorPaths = new Set(restore.map((r) => r.path));
  const remove = row.tx.outputs.map((o) => o.path).filter((p) => !priorPaths.has(p));

  // The revert's own `prior` is the CURRENT state of everything it touches,
  // so that reverting the revert redoes the original exactly.
  const revertPrior: { path: string; sha256: string }[] = [];
  const revertPriorContents = new Map<string, string>();
  for (const p of [...remove, ...priorPaths].sort()) {
    const abs = join(treeDir, p);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    revertPrior.push({ path: p, sha256: sha256Hex(content) });
    revertPriorContents.set(p, content);
  }

  const ts = now ?? new Date().toISOString();
  const outputs: EmittedFile[] = restore.map((r) => ({ path: r.path, origins: row.tx.inputs }));
  const revertTx: ReadabilityTransaction = {
    id: sha256Hex(JSON.stringify(["revert", txId, who, ts])),
    op: row.tx.op,
    who,
    tier: "suggested",
    ts,
    inputs: row.tx.inputs,
    outputs,
    equiv: {
      scope: "tree",
      verdict: "PASS",
      oracle: `revert of ${txId} -- restores a tree state already proven by: ${row.tx.equiv.oracle}`,
      coverage: row.tx.equiv.coverage,
      ts,
    },
    evidence: `revert of ${txId} (${row.tx.op}) by ${who}`,
    prior: { files: revertPrior },
  };

  // DB first (spec 18 section 6): if this refuses, the tree is untouched.
  commitTransaction(db, revertTx, { priorContents: revertPriorContents, reverts: txId });

  for (const r of restore) {
    const abs = join(treeDir, r.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, r.content, "utf8");
  }
  for (const p of remove) rmSync(join(treeDir, p), { force: true });

  exportProject(db, projectDir);
  return { txId, revertTxId: revertTx.id, restored: restore.map((r) => ({ path: r.path, sha256: r.sha256 })), removed: remove };
}

// ---------------------------------------------------------------------------
// Traceability (spec 28 section 9.5's binding-id chain)
// ---------------------------------------------------------------------------

export interface FileTrace {
  readonly path: string;
  /** The transaction that last emitted this path, if any. */
  readonly txId?: string;
  /** `{fn,reg}` binding ids / module indices the file derives from. */
  readonly origins: readonly BindingOrigin[];
  /** The distinct module indices behind `origins`. */
  readonly modules: readonly number[];
  /** True when nothing in the log claims this path -- the condition spec 28
   *  section 7 requires zero of. */
  readonly orphan: boolean;
}

/** Walks `EmittedFile.origins -> BindingOrigin -> module index -> {fn,reg}`
 *  backwards from a path in the readable tree. The answer is the origins of
 *  the MOST RECENT transaction that emitted the path, which is why a
 *  combined-then-split file still reaches its binding ids: `combine` carries
 *  every contributing origin into the merged file, and `split` carries the
 *  per-part subset into each part. */
export function traceFile(db: DatabaseSync, path: string): FileTrace {
  const rows = readTransactionRows(db);
  for (let i = rows.length - 1; i >= 0; i--) {
    const emitted = rows[i]!.tx.outputs.find((o) => o.path === path);
    if (emitted === undefined) continue;
    const modules = [...new Set(emitted.origins.map((o) => o.module))].sort((a, b) => a - b);
    return { path, txId: rows[i]!.tx.id, origins: emitted.origins, modules, orphan: emitted.origins.length === 0 };
  }
  return { path, origins: [], modules: [], orphan: true };
}

/** Every path the log currently claims, with its trace. The exit criterion
 *  "100% of emitted files have >= 1 origin" is this list with no `orphan`. */
export function traceAllEmitted(db: DatabaseSync): readonly FileTrace[] {
  const paths = new Set<string>();
  for (const row of readTransactionRows(db)) for (const o of row.tx.outputs) paths.add(o.path);
  return [...paths].sort().map((p) => traceFile(db, p));
}
