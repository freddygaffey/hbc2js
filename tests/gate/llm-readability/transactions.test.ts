// Spec 28 landing 3 acceptance: the readability transaction log itself
// (section 9.5) -- what it refuses BEFORE writing anything, the spec 18
// section 6 write order, the byte-exact revert guarantee, revert-of-revert,
// and the binding-id trace. The file-op layer on top is `file-ops.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportProject } from "../../../src/projdb/export.ts";
import { verifyProject } from "../../../src/projdb/verify.ts";
import {
  TransactionRefused,
  commitTransaction,
  listTransactions,
  recordTransaction,
  revertTransaction,
  sha256,
  traceAllEmitted,
  traceFile,
  transactionId,
} from "../../../src/readability/transactions.ts";
import { TRANSACTION_OPS, FILE_OP_KINDS } from "../../../src/readability/types.ts";
import type { EquivProof, ReadabilityTransaction } from "../../../src/readability/types.ts";
import { makeTree } from "../../support/readability-tree.ts";

const passing: EquivProof = {
  scope: "tree",
  verdict: "PASS",
  oracle: "hbc2js equiv --hbc fixture.hbc tree/",
  coverage: { inputs: 8, records: 42 },
  ts: "2026-09-11T00:00:00Z",
};

function txFor(path: string, content: string, over: Partial<ReadabilityTransaction> = {}): ReadabilityTransaction {
  const inputs = [{ module: 1 }];
  const outputs = [{ path, origins: inputs }];
  return {
    id: transactionId("rename", inputs, outputs, `landing 3 test: ${path}`),
    op: "rename",
    who: "worker:haiku",
    tier: "suggested",
    ts: "2026-09-11T00:00:01Z",
    inputs,
    outputs,
    equiv: passing,
    evidence: `landing 3 test: ${path}`,
    prior: { files: [{ path, sha256: sha256(content) }] },
    ...over,
  };
}

test("spec 28 P-58: `rewrite` is a first-class op in the transaction log, and FILE_OP_KINDS stays the five FILE ops", () => {
  assert.deepEqual([...FILE_OP_KINDS], ["make", "rename", "move", "combine", "split"]);
  assert.deepEqual([...TRANSACTION_OPS], ["make", "rename", "move", "combine", "split", "rewrite"]);
});

test("spec 28 section 9.5: recording a transaction writes the DB row, the shard and the log entry, in that order", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const tx = txFor("src/module_1.js", content);
  const result = recordTransaction(f.db, f.projectDir, tx, { priorContents: new Map([["src/module_1.js", content]]) });

  assert.equal(result.id, tx.id);
  const rows = listTransactions(f.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.tx.id, tx.id);
  assert.ok(existsSync(join(f.projectDir, "analysis", "readability", `${tx.id}.json`)), "the shard family must be materialised");
  const shard = JSON.parse(readFileSync(join(f.projectDir, "analysis", "readability", `${tx.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal(shard.id, tx.id);
  assert.ok(typeof shard.contentHash === "string", "the shard carries spec 18's hash lock");
  assert.ok(typeof shard.stateBinding === "object", "the shard carries spec 18's state binding");
  const logLines = readFileSync(join(f.projectDir, "log", "2026-09-11.jsonl"), "utf8").trim().split("\n");
  assert.equal(logLines.length, 1);
  const entry = JSON.parse(logLines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(entry.op, "readability");
  assert.equal(entry.target, tx.id);
  assert.equal(entry.prevHash, "genesis");
  f.db.close();
});

test("spec 28 section 9.5: a zero-origin output is refused at write time and nothing at all is written", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const orphan = txFor("src/module_1.js", content, { outputs: [{ path: "src/module_1.js", origins: [] }] });
  assert.throws(
    () => recordTransaction(f.db, f.projectDir, orphan, { priorContents: new Map([["src/module_1.js", content]]) }),
    (e: unknown) => e instanceof TransactionRefused && e.problems.some((p) => p.code === "orphan-file"),
  );
  assert.equal(listTransactions(f.db).length, 0);
  assert.ok(!existsSync(join(f.projectDir, "analysis", "readability")), "a refused transaction writes no shard");
  f.db.close();
});

test("spec 28 section 9.5: a transaction whose prior content is missing or mis-hashed is refused -- the revert guarantee cannot be faked", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const tx = txFor("src/module_1.js", content);
  assert.throws(
    () => commitTransaction(f.db, tx),
    (e: unknown) => e instanceof TransactionRefused && e.problems.some((p) => p.detail.includes("no content supplied")),
  );
  assert.throws(
    () => commitTransaction(f.db, tx, { priorContents: new Map([["src/module_1.js", `${content}// tampered\n`]]) }),
    (e: unknown) => e instanceof TransactionRefused && e.problems.some((p) => p.detail.includes("hashes to")),
  );
  assert.equal(listTransactions(f.db).length, 0);
  f.db.close();
});

test("spec 28 section 1: a worker cannot write tier=confirmed through the log", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const tx = txFor("src/module_1.js", content, { tier: "confirmed" });
  assert.throws(
    () => commitTransaction(f.db, tx, { priorContents: new Map([["src/module_1.js", content]]) }),
    (e: unknown) => e instanceof TransactionRefused && e.problems.some((p) => p.code === "self-promoted"),
  );
  f.db.close();
});

test("spec 18 section 7: the same op over the same inputs with the same evidence dedups -- the id is a content hash", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const a = txFor("src/module_1.js", content);
  const b = txFor("src/module_1.js", content, { who: "fred", tier: "suggested", ts: "2026-09-11T05:00:00Z" });
  assert.equal(a.id, b.id, "who/tier/ts are provenance, not identity");
  commitTransaction(f.db, a, { priorContents: new Map([["src/module_1.js", content]]) });
  assert.throws(
    () => commitTransaction(f.db, b, { priorContents: new Map([["src/module_1.js", content]]) }),
    (e: unknown) => e instanceof TransactionRefused && e.message.includes("already recorded"),
  );
  assert.equal(listTransactions(f.db).length, 1);
  f.db.close();
});

test("spec 28 section 9.5: a crash between the DB commit and the export leaves a rebuildable state -- re-exporting completes the write", () => {
  const f = makeTree();
  const content = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const tx = txFor("src/module_1.js", content);
  // Step 1 only: the process dies here, before the shard and the log entry.
  commitTransaction(f.db, tx, { priorContents: new Map([["src/module_1.js", content]]) });
  assert.equal(listTransactions(f.db).length, 1, "the DB is authoritative and already has the whole transaction");
  assert.ok(!existsSync(join(f.projectDir, "analysis", "readability", `${tx.id}.json`)));
  // Recovery is a plain re-export (`hbcproj export`), nothing bespoke.
  exportProject(f.db, f.projectDir);
  assert.ok(existsSync(join(f.projectDir, "analysis", "readability", `${tx.id}.json`)));
  const v = verifyProject(f.db, f.projectDir, { full: true });
  assert.equal(v.ok, true, v.full?.detail.join("; "));
  assert.equal(v.full?.readability.checked, 1);
  f.db.close();
});

test("spec 28 section 7 (reversibility): revert restores the prior bytes exactly, is itself a transaction, and revert-of-revert redoes it", () => {
  const f = makeTree();
  const path = "src/module_1.js";
  const abs = join(f.treeDir, path);
  const original = readFileSync(abs, "utf8");
  const tx = txFor(path, original);
  recordTransaction(f.db, f.projectDir, tx, { priorContents: new Map([[path, original]]) });
  // The transformation the log describes actually happening to the tree.
  const changed = `// renamed by the readability layer\n${original}`;
  writeFileSync(abs, changed, "utf8");

  const r = revertTransaction(f.db, f.projectDir, f.treeDir, tx.id, "fred", "2026-09-11T00:00:02Z");
  assert.equal(readFileSync(abs, "utf8"), original, "revert must restore the prior bytes exactly");
  assert.deepEqual(r.restored, [{ path, sha256: sha256(original) }]);
  const afterRevert = listTransactions(f.db);
  assert.equal(afterRevert.length, 2, "the revert is itself an auditable transaction");
  assert.equal(afterRevert[1]?.reverts, tx.id);
  assert.equal(afterRevert[1]?.tx.who, "fred");

  // Reverting the revert puts the change back, byte for byte.
  const r2 = revertTransaction(f.db, f.projectDir, f.treeDir, r.revertTxId, "fred", "2026-09-11T00:00:03Z");
  assert.equal(readFileSync(abs, "utf8"), changed, "revert-of-revert must redo the original change exactly");
  assert.equal(r2.revertTxId.length, 64);
  assert.equal(listTransactions(f.db).length, 3);

  // And a transaction is never reverted twice.
  assert.throws(
    () => revertTransaction(f.db, f.projectDir, f.treeDir, tx.id, "fred", "2026-09-11T00:00:04Z"),
    (e: unknown) => e instanceof TransactionRefused && e.message.includes("already reverted"),
  );
  f.db.close();
});

test("spec 28 section 9.5: traceFile walks an emitted path back to its module indices and {fn,reg} binding ids", () => {
  const f = makeTree();
  const path = "src/module_1.js";
  const content = readFileSync(join(f.treeDir, path), "utf8");
  assert.ok(f.bindings.length > 0, "the fixture must supply real register binding ids");
  const inputs = f.bindings;
  const outputs = [{ path: "src/auth/LoginScreen.js", origins: inputs }];
  const tx: ReadabilityTransaction = {
    id: transactionId("move", inputs, outputs, "route literal /login"),
    op: "move",
    who: "worker:haiku",
    tier: "suggested",
    ts: "2026-09-11T00:00:05Z",
    inputs,
    outputs,
    equiv: passing,
    evidence: "route literal /login",
    prior: { files: [{ path, sha256: sha256(content) }] },
  };
  recordTransaction(f.db, f.projectDir, tx, { priorContents: new Map([[path, content]]) });

  const trace = traceFile(f.db, "src/auth/LoginScreen.js");
  assert.equal(trace.orphan, false);
  assert.equal(trace.txId, tx.id);
  assert.ok(trace.origins.every((o) => o.binding !== undefined), "every origin carries a {fn,reg} binding id");
  assert.ok(trace.modules.length > 0);
  // A path the log never emitted is reported as an orphan rather than
  // silently answered.
  assert.equal(traceFile(f.db, "src/nowhere.js").orphan, true);
  // The section 7 exit criterion, as a measurement over this log.
  const all = traceAllEmitted(f.db);
  assert.equal(all.filter((t) => t.orphan).length, 0);
  assert.equal(all.length, 1);
  f.db.close();
});
