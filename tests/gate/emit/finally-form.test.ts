// spec 30 section 3.2 -- the IR/emit half of `finally-dedup`, on hand-built
// trees only: no fixture is decompiled here, so nothing in this file can
// depend on what any rung currently folds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { printProgram } from "../../../src/emit/print.ts";
import { printTree } from "../../../src/structure/print.ts";
import { childLists, mapChildLists } from "../../../src/passes/restructure.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import type { FinallyForm, Stmt as IrStmt, StructuredFunction } from "../../../src/structure/ir.ts";

const call = (name: string): Stmt => ({ k: "expr", expr: { k: "call", callee: { k: "ident", name }, args: [] } });

test("spec 30: a `try` with a finalizer and no catch clause prints `try { } finally { }`", () => {
  const node: Stmt = { k: "try", block: [call("body")], param: null, handler: [], hasCatch: false, finalizer: [call("cleanup")] };
  assert.equal(printProgram([node]), "try {\n  body();\n} finally {\n  cleanup();\n}\n");
});

test("spec 30: a `try` with both a catch clause and a finalizer prints both, in order", () => {
  const node: Stmt = { k: "try", block: [call("body")], param: "e", handler: [call("caught")], finalizer: [call("cleanup")] };
  assert.equal(printProgram([node]), "try {\n  body();\n} catch (e) {\n  caught();\n} finally {\n  cleanup();\n}\n");
});

test("spec 30: an unfolded `try` prints exactly as it did before the field existed", () => {
  const node: Stmt = { k: "try", block: [call("body")], param: "e", handler: [call("caught")] };
  assert.equal(printProgram([node]), "try {\n  body();\n} catch (e) {\n  caught();\n}\n");
});

test("spec 30: the finalizer is a child statement list for the shared AST walkers", () => {
  const node: Stmt = { k: "try", block: [call("body")], param: null, handler: [], hasCatch: false, finalizer: [call("cleanup")] };
  assert.deepEqual(childLists(node).map((c) => c.seg), ["try-block", "try-handler", "try-finalizer"]);
  const mapped = mapChildLists(node, (list, seg) => (seg === "try-finalizer" ? [...list, call("extra")] : list));
  assert.equal((mapped as Stmt & { k: "try" }).finalizer?.length, 2);
  // A `try` with no finalizer gains no `finalizer` key at all (the
  // `--passes=none` AST must stay byte-identical).
  const plain: Stmt = { k: "try", block: [], param: "e", handler: [] };
  assert.deepEqual(childLists(plain).map((c) => c.seg), ["try-block", "try-handler"]);
  assert.equal("finalizer" in (mapChildLists(plain, (l) => l) as object), false);
});

const irTry = (finalizer?: FinallyForm): IrStmt => ({ k: "try", region: 0, cfgBlock: 4, body: { k: "block", cfgBlock: 1 }, handler: { k: "throw", cfgBlock: 3 }, catchRegister: 0, ...(finalizer === undefined ? {} : { finalizer }) });
const structured = (root: IrStmt): StructuredFunction => ({ root, labels: new Map(), duplicatedBlocks: new Map(), dispatchVars: [], graph: undefined as never } as unknown as StructuredFunction);

test("spec 30: --emit-tree shows the finalizer annotation, and nothing when it is absent", () => {
  assert.match(printTree(structured(irTry())), /^try r0 \(head b4\) \{$/m);
  const form: FinallyForm = { source: { cfgBlock: 3, from: 1, to: 4 }, copies: [{ cfgBlock: 2, from: 0, to: 3, retained: [0] }], handlerIsRethrowOnly: true };
  assert.match(printTree(structured(irTry(form))), /^try r0 \(head b4\) finalizer=b3\[1,4\) copies=\[b2\[0,3\)keep0\] \{$/m);
  const caseB: FinallyForm = { source: { cfgBlock: 3, from: 1, to: 3 }, copies: [{ cfgBlock: 2, from: 0, to: 2 }], handlerIsRethrowOnly: false };
  assert.match(printTree(structured(irTry(caseB))), /finalizer=b3\[1,3\)\+exit copies=\[b2\[0,2\)\]/);
});
