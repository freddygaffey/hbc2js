// docs/specs/passes/01-framework-fixes.md F4 — `items`/`isBreakTo`/`isContinueTo`
// hoisted into src/passes/tree.ts (both shipped rungs private-defined these;
// batch 1 would have been the third copy). Also a smoke test for F6's
// `buildModuleView`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { isBreakTo, isContinueTo, items } from "../../../src/passes/tree.ts";
import { buildModuleView } from "../../../src/passes/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { analyseModule } from "../../../src/cfg/index.ts";

test("items: a seq's own body, or a single-element view of anything else", () => {
  const a: Stmt = { k: "block", cfgBlock: 0 };
  const b: Stmt = { k: "block", cfgBlock: 1 };
  assert.deepEqual(items({ k: "seq", body: [a, b] }), [a, b]);
  assert.deepEqual(items(a), [a]);
});

test("isBreakTo / isContinueTo: exactly break/continue naming the given label, never the other kind or a different label", () => {
  const brk: Stmt = { k: "break", label: 3 };
  const cont: Stmt = { k: "continue", label: 3 };
  assert.equal(isBreakTo(brk, 3), true);
  assert.equal(isBreakTo(brk, 4), false);
  assert.equal(isBreakTo(cont, 3), false, "a continue is not a break, even to the same label");
  assert.equal(isContinueTo(cont, 3), true);
  assert.equal(isContinueTo(cont, 4), false);
  assert.equal(isContinueTo(brk, 3), false, "a break is not a continue, even to the same label");
  assert.equal(isBreakTo({ k: "block", cfgBlock: 0 }, 3), false);
});

test("buildModuleView (F6): functionCount, functionName, isGlobalFunction, envSlotAccesses over a real module", () => {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "17-closure-loop-var", "v94.hbc")));
  const module = parseHbc(bytes);
  const analysis = analyseModule(module, { strictEnv: true });
  const view = buildModuleView(analysis);
  assert.equal(view.functionCount, module.functions.length);
  assert.equal(view.isGlobalFunction(module.header.globalCodeIndex), true);
  assert.equal(view.isGlobalFunction(module.header.globalCodeIndex + 1000), false);
  assert.equal(typeof view.functionName(module.header.globalCodeIndex), "string");
  assert.equal(view.depsVerdict(), null, "nothing sets a deps verdict in batch 1");
  // Every accessor returns an array, even for a slot nothing uses.
  assert.deepEqual(view.envSlotAccesses(999999, 0), []);
});
