// Spec 28 landing 4 (section 9.7): one round-trip test per MCP tool over
// `src/readability/surfaces.ts`, plus the exit criterion -- a driver using
// only these functions can suggest, review, promote and revert, and is
// REFUSED when it tries to (a) promote as `worker:haiku`, (b) push a rewrite
// that fails the equivalence gate, (c) record a change with a zero-origin
// output. No exact-output assertion on the shared fixture
// (docs/CONSOLIDATION.md section B item 7): every candidate here is derived
// from whatever the decompiler renders today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { makeTree } from "../../support/readability-tree.ts";
import { decompile } from "../../../src/decompile.ts";
import { emittedFunctionName, findFunctionSpan } from "../../../src/readability/rewrite.ts";
import type { FunctionEquivRequest, FunctionEquivResult, FunctionEquivVerdict } from "../../../src/harness/hbc-equiv.ts";
import type { TreeEquivOracle } from "../../../src/readability/file-ops.ts";
import { FakeBackend } from "../../../src/workers/backend.ts";
import { getTransaction, listTransactions } from "../../../src/readability/transactions.ts";
import { TransactionRefused } from "../../../src/readability/transactions.ts";
import { FileOpError } from "../../../src/readability/file-ops.ts";
import {
  ReadabilitySurfaceError,
  classifyModule,
  fileOp,
  inferModuleRole,
  listSuggestions,
  promoteChange,
  revertChange,
  rewriteFunction,
  suggestNames,
} from "../../../src/readability/surfaces.ts";
import type { ReadabilityContext } from "../../../src/readability/surfaces.ts";

const FIXTURE = "04-for-loop-basic";
const VERSION = 84;
const FN = 0;
const FN_NAME = emittedFunctionName(FN);

function hbcPath(): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${String(VERSION)}.hbc`);
}

function faithfulRender(): string {
  return decompile(new Uint8Array(readFileSync(hbcPath()))).code;
}

function fnText(code: string): string {
  const span = findFunctionSpan(code, FN_NAME);
  assert.notEqual(span, undefined, `the render should contain function ${FN_NAME}`);
  return code.slice(span!.start, span!.end);
}

function equivalentRewrite(code: string): string {
  const text = fnText(code);
  const open = text.indexOf("{");
  const body = text.slice(open + 1, text.lastIndexOf("}"));
  return `${text.slice(0, open + 1)}\n  (function () { ${body} }).call(this);\n}`;
}

function divergentRewrite(code: string): string {
  const text = fnText(code);
  const open = text.indexOf("{");
  return `${text.slice(0, open + 1)}\n  print("rewritten");${text.slice(open + 1)}`;
}

function stubOracle(verdict: FunctionEquivVerdict): (req: FunctionEquivRequest) => Promise<FunctionEquivResult> {
  return (req) =>
    Promise.resolve({
      verdict,
      why: `stub ${verdict}`,
      oracle: `hbc2js equiv --hbc ${req.hbcPath} <candidate>`,
      coverage: { inputs: 0, records: verdict === "INCONCLUSIVE" ? 0 : 4 },
      legs: [{ name: "module-hbc", verdict, why: `stub ${verdict}` }],
    });
}

const PASS_TREE: TreeEquivOracle = () => ({ verdict: "PASS", why: "trace-equivalent over the reconstructed tree", oracle: "hbc2js equiv --hbc fixture.hbc tree/", lines: 4 });

function rewriteReply(code: string, evidence = "restated the loop"): string {
  return JSON.stringify({ names: [], rewrite: { fn: FN, code, confidence: "med", evidence }, abstained: false });
}

function ctxFor(verdict: FunctionEquivVerdict, backend: FakeBackend): ReadabilityContext & { treeDir: string; projectDir: string } {
  const { db, treeDir, projectDir } = makeTree();
  return { db, projectDir, treeDir, backend, hbcPath: hbcPath(), functionOracle: stubOracle(verdict) };
}

test("suggest_names: round-trips through FakeBackend, is equiv-verified, and rejects a malformed target", async () => {
  const backend = new FakeBackend({ replies: { "suggest-name": () => JSON.stringify({ names: [{ bindingId: { fn: 0, reg: 9 }, name: "loopCount", confidence: "high", evidence: "loop bound" }], abstained: false }) } });
  const { db, treeDir, projectDir } = makeTree();
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath: hbcPath() };
  const result = await suggestNames(ctx, { target: { fn: 0 } });
  assert.equal(result.equiv.scope, "name");
  assert.equal(result.equiv.verdict, "PASS");
  assert.ok(result.suggestions.length > 0);
  assert.deepEqual(result.txIds, []);
  assert.equal(result.evaluation, undefined);
  await assert.rejects(() => suggestNames(ctx, { target: {} as { fn: number } }), ReadabilitySurfaceError);
  await assert.rejects(() => suggestNames(ctx, { target: { fn: 0, module: 0 } as unknown as { fn: number } }), ReadabilitySurfaceError);
});

test("classify_module: derives a role from the model's own evidence, and abstains to low confidence rather than guessing", async () => {
  assert.equal(inferModuleRole("this is the LoginScreen component"), "screen");
  assert.equal(inferModuleRole("nothing recognisable here"), undefined);
  const backend = new FakeBackend({ replies: { "name-module": () => JSON.stringify({ names: [{ bindingId: { fn: 0 }, name: "LoginScreen.js", confidence: "high", evidence: "renders a screen" }], abstained: false }) } });
  const { db, treeDir, projectDir } = makeTree();
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath: hbcPath() };
  const result = await classifyModule(ctx, { module: 1 });
  assert.equal(result.role, "screen");
  assert.equal(result.path, "LoginScreen.js");
  assert.equal(result.txId, undefined);

  const abstaining = new FakeBackend({ replies: { "name-module": () => JSON.stringify({ names: [], abstained: true }) } });
  const abstained = await classifyModule({ ...ctx, backend: abstaining }, { module: 1 });
  assert.equal(abstained.role, undefined);
  assert.equal(abstained.confidence, "low");
});

test("rewrite_function: an accepted rewrite is DB-tracked and reviewable; a DIVERGENT one is refused and changes nothing", async () => {
  const code = faithfulRender();
  const acceptedBackend = new FakeBackend({ replies: { "suggest-name": () => rewriteReply(equivalentRewrite(code)) } });
  const acceptedCtx = ctxFor("PASS", acceptedBackend);
  const accepted = await rewriteFunction(acceptedCtx, { fn: FN });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.equiv.verdict, "PASS");
  assert.ok(accepted.txId !== undefined);
  const row = getTransaction(acceptedCtx.db, accepted.txId!);
  assert.equal(row?.tx.op, "rewrite");
  assert.equal(row?.tx.tier, "suggested");

  const divergentBackend = new FakeBackend({ replies: { "suggest-name": () => rewriteReply(divergentRewrite(code)) } });
  const divergentCtx = ctxFor("DIVERGENT", divergentBackend);
  const rejected = await rewriteFunction(divergentCtx, { fn: FN });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.equiv.verdict, "DIVERGENT");
  assert.equal(rejected.txId, undefined);
  assert.equal(listTransactions(divergentCtx.db).length, 0);
});

test("file_op: a PASSing op is DB-tracked; a zero-origin `make` is refused before the tree is touched", () => {
  const { db, treeDir, projectDir } = makeTree();
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend: new FakeBackend({}), oracle: PASS_TREE };
  const result = fileOp(ctx, { op: "rename", from: "src/module_1.js", to: "src/first.js", evidence: "clearer name" });
  assert.equal(result.accepted, true);
  assert.ok(result.txId !== undefined);
  assert.equal(result.equiv.scope, "tree");

  assert.throws(() => fileOp(ctx, { op: "make", path: "src/new.js", content: "module.exports = {};\n", origins: [], evidence: "no evidence at all" }), (e: unknown) => e instanceof TransactionRefused || e instanceof FileOpError);
});

test("promote_change / revert_change / list_suggestions: the review loop, and the two provenance refusals", () => {
  const { db, treeDir, projectDir } = makeTree();
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend: new FakeBackend({}), oracle: PASS_TREE };
  const made = fileOp(ctx, { op: "rename", from: "src/module_1.js", to: "src/renamed.js", evidence: "clearer name" });
  assert.equal(made.accepted, true);
  const txId = made.txId!;

  assert.equal(listSuggestions(ctx).total, 1);
  assert.equal(listSuggestions(ctx, { filter: { tier: "confirmed" } }).total, 0);

  // (a) refused: a worker may not self-promote.
  assert.throws(() => promoteChange(ctx, { txId, who: "worker:haiku" }), (e: unknown) => e instanceof TransactionRefused);
  assert.equal(listSuggestions(ctx, { filter: { tier: "confirmed" } }).total, 0);

  const promoted = promoteChange(ctx, { txId, who: "reviewer:fred" });
  assert.equal(promoted.tier, "confirmed");
  assert.equal(listSuggestions(ctx, { filter: { tier: "confirmed" } }).total, 1);

  const reverted = revertChange(ctx, { txId });
  assert.equal(reverted.txId, txId);
  assert.ok(reverted.revertedTxId.length > 0);
});

test("exit criterion: a driver using only surfaces.ts can suggest, review, promote and revert, and is refused three ways", async () => {
  const { db, treeDir, projectDir } = makeTree();
  const code = faithfulRender();
  const backend = new FakeBackend({ replies: { "suggest-name": () => rewriteReply(equivalentRewrite(code)) } });
  const ctx: ReadabilityContext = { db, projectDir, treeDir, backend, hbcPath: hbcPath(), functionOracle: stubOracle("PASS"), oracle: PASS_TREE };

  // Suggest.
  const rewrite = await rewriteFunction(ctx, { fn: FN });
  assert.equal(rewrite.accepted, true);
  // Review.
  const queue = listSuggestions(ctx);
  assert.equal(queue.total, 1);
  // (a) refused: worker: may not promote.
  assert.throws(() => promoteChange(ctx, { txId: rewrite.txId!, who: "worker:haiku" }));
  // Promote.
  const promoted = promoteChange(ctx, { txId: rewrite.txId!, who: "fred" });
  assert.equal(promoted.tier, "confirmed");
  // Revert.
  const reverted = revertChange(ctx, { txId: rewrite.txId! });
  assert.ok(reverted.restored.length > 0);

  // (b) refused: a DIVERGENT rewrite never lands, whoever proposed it.
  const badCtx: ReadabilityContext = { ...ctx, functionOracle: stubOracle("DIVERGENT"), backend: new FakeBackend({ replies: { "suggest-name": () => rewriteReply(divergentRewrite(code)) } }) };
  const bad = await rewriteFunction(badCtx, { fn: FN });
  assert.equal(bad.accepted, false);
  assert.equal(bad.txId, undefined);

  // (c) refused: a zero-origin output is an orphan and the transaction is refused.
  assert.throws(() => fileOp(ctx, { op: "make", path: "src/orphan.js", content: "module.exports = {};\n", origins: [], evidence: "nothing backs this" }));
});
