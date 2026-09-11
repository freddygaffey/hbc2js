// Spec 28 landing 3 acceptance: the five file ops over a split tree, each
// gated by section 9.4's FILE OP row (require graph resolves identically,
// exports preserved, tree-level equiv PASS). Every op is exercised ACCEPTED
// and REJECTED, and a rejection must leave the tree byte-for-byte untouched.
//
// The behavioural leg is driven through an INJECTED oracle: the gate's job is
// to honour the verdict it is given (PASS applies and records, anything else
// refuses), and no gate test may depend on a Hermes VM being present. The
// shipped oracle's own wiring -- and the fact that a missing bundle is
// INCONCLUSIVE, never a free pass -- is asserted separately below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultTreeEquivOracle,
  readTree,
  runFileOp,
  treeHash,
  FileOpError,
} from "../../../src/readability/file-ops.ts";
import type { TreeEquivOracle } from "../../../src/readability/file-ops.ts";
import { TransactionRefused, listTransactions, revertTransaction, traceAllEmitted, traceFile } from "../../../src/readability/transactions.ts";
import { makeTree } from "../../support/readability-tree.ts";
import type { Fixture } from "../../support/readability-tree.ts";

const PASS: TreeEquivOracle = () => ({ verdict: "PASS", why: "trace-equivalent over the reconstructed tree", oracle: "hbc2js equiv --hbc fixture.hbc tree/", lines: 37 });
const DIVERGENT: TreeEquivOracle = () => ({ verdict: "DIVERGENT", why: "output line 3 differs", oracle: "hbc2js equiv --hbc fixture.hbc tree/", lines: 3 });
const INCONCLUSIVE: TreeEquivOracle = () => ({ verdict: "INCONCLUSIVE", why: "no VM for this bytecode version", oracle: "hbc2js equiv --hbc fixture.hbc tree/", lines: 0 });

function opts(f: Fixture, oracle: TreeEquivOracle, ts = "2026-09-11T00:00:00Z") {
  return { db: f.db, projectDir: f.projectDir, treeDir: f.treeDir, oracle, ts };
}

test("spec 28 section 9.4 (FILE OP): make / rename / move / combine / split are each accepted on a PASS and recorded as a transaction", () => {
  const f = makeTree();
  const made = runFileOp(
    { op: "make", path: "src/loop-helper.js", content: "function helper() { return 1; }\nexports.helper = helper;\n", origins: f.bindings.slice(0, 1), evidence: "extracted loop body" },
    opts(f, PASS),
  );
  assert.equal(made.accepted, true);
  assert.ok(existsSync(join(f.treeDir, "src/loop-helper.js")));

  const renamed = runFileOp({ op: "rename", from: "src/module_1.js", to: "src/LoginScreen.js", evidence: "route literal /login" }, opts(f, PASS));
  assert.equal(renamed.accepted, true);
  assert.ok(!existsSync(join(f.treeDir, "src/module_1.js")));
  const index = JSON.parse(readFileSync(join(f.treeDir, "MODULES.json"), "utf8")) as { modules: { id: number; file: string }[] };
  assert.equal(index.modules.find((m) => m.id === 1)?.file, "src/LoginScreen.js", "the require graph is rewritten with the file");

  const moved = runFileOp({ op: "move", from: "src/LoginScreen.js", to: "src/auth/LoginScreen.js", evidence: "auth feature folder" }, opts(f, PASS));
  assert.equal(moved.accepted, true);
  assert.ok(existsSync(join(f.treeDir, "src/auth/LoginScreen.js")));

  const combined = runFileOp({ op: "combine", from: ["src/auth/LoginScreen.js", "src/module_2.js"], to: "src/auth/Login.js", evidence: "one unit" }, opts(f, PASS));
  assert.equal(combined.accepted, true);
  assert.ok(!existsSync(join(f.treeDir, "src/module_2.js")));

  const body = readFileSync(join(f.treeDir, "src/auth/Login.js"), "utf8");
  const cut = body.indexOf("function second");
  assert.ok(cut > 0, "the combined file must contain both module bodies");
  const split = runFileOp(
    {
      op: "split",
      from: "src/auth/Login.js",
      parts: [
        { path: "src/auth/LoginForm.js", content: body.slice(0, cut), origins: f.bindings.slice(0, 1) },
        { path: "src/auth/LoginSession.js", content: body.slice(cut), origins: f.bindings.slice(1, 2) },
      ],
      evidence: "two responsibilities",
    },
    opts(f, PASS),
  );
  assert.equal(split.accepted, true, split.detail);

  const rows = listTransactions(f.db);
  assert.deepEqual(rows.map((r) => r.tx.op), ["make", "rename", "move", "combine", "split"]);
  assert.ok(rows.every((r) => r.tx.equiv.verdict === "PASS" && r.tx.tier === "suggested" && r.tx.who === "worker:haiku"));
  f.db.close();
});

test("spec 28 section 9.5 (traceability): a combined-then-split file still traces to its {fn,reg} binding ids, and nothing is orphaned", () => {
  const f = makeTree();
  runFileOp({ op: "combine", from: ["src/module_1.js", "src/module_2.js"], to: "src/Login.js", evidence: "one unit" }, opts(f, PASS));
  const combinedTrace = traceFile(f.db, "src/Login.js");
  assert.equal(combinedTrace.orphan, false);
  assert.deepEqual(combinedTrace.modules, [1, 2], "combine carries EVERY contributing origin into the merged file");

  const body = readFileSync(join(f.treeDir, "src/Login.js"), "utf8");
  const cut = body.indexOf("function second");
  runFileOp(
    {
      op: "split",
      from: "src/Login.js",
      parts: [
        { path: "src/LoginForm.js", content: body.slice(0, cut), origins: f.bindings.filter((b) => b.module === 1) },
        { path: "src/LoginSession.js", content: body.slice(cut), origins: f.bindings.filter((b) => b.module === 2) },
      ],
      evidence: "two responsibilities",
    },
    opts(f, PASS),
  );
  const partTrace = traceFile(f.db, "src/LoginForm.js");
  assert.equal(partTrace.orphan, false);
  assert.ok(partTrace.origins.length > 0 && partTrace.origins.every((o) => o.binding !== undefined), "a split part reaches the {fn,reg} ids, not just a module index");

  // The landing's exit criterion, measured: 100% of emitted files have >= 1
  // origin.
  const all = traceAllEmitted(f.db);
  assert.equal(all.length, 3);
  assert.equal(all.filter((t) => t.orphan).length, 0);
  f.db.close();
});

test("spec 28 section 9.4: a DIVERGENT tree verdict rejects the op -- the tree is byte-for-byte untouched and nothing is recorded", () => {
  const f = makeTree();
  const before = treeHash(readTree(f.treeDir));
  const attempt = runFileOp({ op: "combine", from: ["src/module_1.js", "src/module_2.js"], to: "src/Login.js", evidence: "one unit" }, opts(f, DIVERGENT));
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.proof.verdict, "DIVERGENT");
  assert.equal(attempt.detail, "output line 3 differs", "the attempt carries the oracle's reason so a human can see what was rejected");
  assert.equal(attempt.priorTreeHash, before);
  assert.equal(treeHash(readTree(f.treeDir)), before, "a rejected file op leaves the tree untouched");
  assert.equal(listTransactions(f.db).length, 0);
  assert.ok(!existsSync(join(f.projectDir, "analysis", "readability")));
  f.db.close();
});

test("spec 28 section 9.4: INCONCLUSIVE is never PASS, and the shipped oracle with no bundle is INCONCLUSIVE rather than a free pass", () => {
  const f = makeTree();
  const before = treeHash(readTree(f.treeDir));
  const attempt = runFileOp({ op: "rename", from: "src/module_1.js", to: "src/Login.js", evidence: "route literal" }, opts(f, INCONCLUSIVE));
  assert.equal(attempt.accepted, false);
  assert.equal(attempt.proof.verdict, "INCONCLUSIVE");
  assert.equal(treeHash(readTree(f.treeDir)), before);
  assert.equal(listTransactions(f.db).length, 0);

  const noBundle = defaultTreeEquivOracle({ treeDir: f.treeDir, entry: "index.js" });
  assert.equal(noBundle.verdict, "INCONCLUSIVE");
  const viaGate = runFileOp({ op: "rename", from: "src/module_1.js", to: "src/Login.js", evidence: "route literal" }, { db: f.db, projectDir: f.projectDir, treeDir: f.treeDir, ts: "2026-09-11T00:00:00Z" });
  assert.equal(viaGate.accepted, false);
  assert.equal(treeHash(readTree(f.treeDir)), before);
  f.db.close();
});

test("spec 28 section 9.4: the structural leg rejects a split that drops an export, even when the behavioural oracle says PASS", () => {
  const f = makeTree();
  const before = treeHash(readTree(f.treeDir));
  const body = readFileSync(join(f.treeDir, "src/module_1.js"), "utf8");
  const attempt = runFileOp(
    {
      op: "split",
      from: "src/module_1.js",
      parts: [
        { path: "src/a.js", content: body.replace("exports.loopBody = loopBody;\n", ""), origins: f.bindings.slice(0, 1) },
        { path: "src/b.js", content: "// the other half\n", origins: f.bindings.slice(1, 2) },
      ],
      evidence: "two responsibilities",
    },
    opts(f, PASS),
  );
  assert.equal(attempt.accepted, false);
  assert.match(attempt.detail, /export surface changed/);
  assert.equal(treeHash(readTree(f.treeDir)), before);
  f.db.close();
});

test("spec 28 section 9.4: the structural leg rejects an op that breaks module resolution", () => {
  const f = makeTree();
  const before = treeHash(readTree(f.treeDir));
  // A split whose parts do not include the source path and whose first part
  // the index is repointed at... is fine; what is NOT fine is a combine that
  // leaves a module id with no file. Simulate by combining into a path the
  // index cannot be repointed at, via a hand-broken index.
  const attempt = runFileOp({ op: "make", path: "MODULES.json", content: `${JSON.stringify({ entry: 0, modules: [{ id: 1, file: "src/gone.js", deps: [] }] }, null, 2)}\n`, origins: f.bindings.slice(0, 1), evidence: "hand-broken index" }, opts(f, PASS));
  assert.equal(attempt.accepted, false);
  assert.match(attempt.detail, /require graph/);
  assert.equal(treeHash(readTree(f.treeDir)), before);
  f.db.close();
});

test("spec 28 section 9.5: an output with no origin is refused by the log, so the tree op never lands", () => {
  const f = makeTree();
  const before = treeHash(readTree(f.treeDir));
  assert.throws(
    () => runFileOp({ op: "make", path: "src/mystery.js", content: "// where did this come from\n", origins: [], evidence: "none" }, opts(f, PASS)),
    (e: unknown) => e instanceof TransactionRefused && e.problems.some((p) => p.code === "orphan-file"),
  );
  assert.equal(treeHash(readTree(f.treeDir)), before, "the DB refuses before the tree is touched");
  assert.equal(listTransactions(f.db).length, 0);
  f.db.close();
});

test("spec 28 section 1c: rename and move are distinct ops and each refuses the other's shape", () => {
  const f = makeTree();
  assert.throws(() => runFileOp({ op: "rename", from: "src/module_1.js", to: "src/auth/Login.js", evidence: "x" }, opts(f, PASS)), FileOpError);
  assert.throws(() => runFileOp({ op: "move", from: "src/module_1.js", to: "src/Login.js", evidence: "x" }, opts(f, PASS)), FileOpError);
  assert.throws(() => runFileOp({ op: "combine", from: ["src/module_1.js"], to: "src/Login.js", evidence: "x" }, opts(f, PASS)), FileOpError);
  assert.equal(listTransactions(f.db).length, 0);
  f.db.close();
});

test("spec 28 section 7 (reversibility): reverting any single file op restores the prior tree hash exactly", () => {
  const f = makeTree();
  const hashes: string[] = [treeHash(readTree(f.treeDir))];
  const ids: string[] = [];
  const ops = [
    { op: "rename" as const, from: "src/module_1.js", to: "src/Login.js", evidence: "route literal /login" },
    { op: "move" as const, from: "src/Login.js", to: "src/auth/Login.js", evidence: "auth feature folder" },
    { op: "combine" as const, from: ["src/auth/Login.js", "src/module_2.js"], to: "src/auth/Session.js", evidence: "one unit" },
  ];
  let i = 0;
  for (const op of ops) {
    const attempt = runFileOp(op, opts(f, PASS, `2026-09-11T00:00:0${String(i)}Z`));
    assert.equal(attempt.accepted, true, attempt.detail);
    assert.equal(attempt.priorTreeHash, hashes[i], "each op records the hash of the tree it started from");
    hashes.push(treeHash(readTree(f.treeDir)));
    ids.push(attempt.txId ?? "");
    i++;
  }
  // Revert them newest-first; after each one the tree must be EXACTLY the
  // tree that existed immediately before that transaction.
  for (let j = ids.length - 1; j >= 0; j--) {
    revertTransaction(f.db, f.projectDir, f.treeDir, ids[j] ?? "", "fred", `2026-09-11T01:00:0${String(j)}Z`);
    assert.equal(treeHash(readTree(f.treeDir)), hashes[j], `reverting transaction ${String(j)} must restore the prior tree hash exactly`);
  }
  assert.equal(listTransactions(f.db).length, 6, "three ops plus three reverts, all auditable");
  f.db.close();
});
