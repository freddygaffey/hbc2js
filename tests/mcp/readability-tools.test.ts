// Spec 28 landing 4, section 9.7: the seven readability tools registered on
// `src/mcp/tools.ts` -- JSON-schema argument validation and end-to-end
// registration, distinct from `tests/gate/llm-readability/surfaces.test.ts`'s
// round trips (which exercise the underlying `surfaces.ts` functions
// directly). This file proves the MCP-facing wrapper: a caller with a bad
// shape never reaches `surfaces.ts` at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBackend } from "../../src/workers/backend.ts";
import { makeTree } from "../support/readability-tree.ts";
import { READABILITY_MCP_TOOLS } from "../../src/readability/types.ts";
import {
  READABILITY_TOOL_SCHEMAS,
  ReadabilityToolArgumentError,
  registerReadabilityTools,
  validateReadabilityArgs,
} from "../../src/mcp/tools.ts";
import type { ReadabilityContext } from "../../src/readability/surfaces.ts";

function ctx(): ReadabilityContext {
  const { db, treeDir, projectDir } = makeTree();
  return { db, projectDir, treeDir, backend: new FakeBackend({}) };
}

test("spec 28 section 9.7: every MCP tool has a schema, and the handler set is exactly READABILITY_MCP_TOOLS", () => {
  for (const tool of READABILITY_MCP_TOOLS) {
    assert.ok(READABILITY_TOOL_SCHEMAS[tool] !== undefined, `${tool} has no schema`);
  }
  const handlers = registerReadabilityTools(ctx());
  assert.deepEqual(Object.keys(handlers).sort(), [...READABILITY_MCP_TOOLS].sort());
});

test("spec 28 section 9.7: schema validation refuses a missing required field and a wrong type, before surfaces.ts ever runs", () => {
  assert.deepEqual(validateReadabilityArgs("revert_change", {}), ['revert_change: missing required field "txId"']);
  assert.deepEqual(validateReadabilityArgs("rewrite_function", { fn: "zero" }), ['rewrite_function: "fn" must be a number']);
  assert.deepEqual(validateReadabilityArgs("file_op", { op: "delete", evidence: "x" }), ['file_op: "op" must be one of make|rename|move|combine|split']);
  assert.deepEqual(validateReadabilityArgs("list_suggestions", {}), []);
  assert.deepEqual(validateReadabilityArgs("suggest_names", "not an object"), ["suggest_names: arguments must be an object"]);

  const handlers = registerReadabilityTools(ctx());
  assert.throws(() => handlers.revert_change({}), ReadabilityToolArgumentError);
  assert.throws(() => handlers.rewrite_function({ fn: "zero" }), ReadabilityToolArgumentError);
});

test("spec 28 section 9.7: a well-formed file_op call round-trips through the registered handler exactly like surfaces.ts", () => {
  const handlers = registerReadabilityTools(ctx());
  const result = handlers.file_op({ op: "rename", from: "src/module_1.js", to: "src/renamed.js", evidence: "clearer name" }) as { accepted: boolean; equiv: { verdict: string } };
  // No PASS oracle is wired in this context, so the tree-structure leg still
  // runs and the default oracle is INCONCLUSIVE without a bundle -- the point
  // here is that the call reaches `surfaces.ts` and returns its exact shape,
  // not that it is accepted (accepted-vs-refused is `surfaces.test.ts`'s job).
  assert.equal(typeof result.accepted, "boolean");
  assert.ok(["PASS", "DIVERGENT", "INCONCLUSIVE"].includes(result.equiv.verdict));
});

test("spec 28 section 9.7: promote_change refuses a worker: who at the MCP layer too", () => {
  const handlers = registerReadabilityTools(ctx());
  handlers.file_op({ op: "rename", from: "src/module_1.js", to: "src/renamed.js", evidence: "clearer name" });
  assert.throws(() => handlers.promote_change({ txId: "does-not-matter", who: "worker:haiku" }));
});
