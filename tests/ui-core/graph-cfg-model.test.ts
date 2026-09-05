// tests/ui-core/graph-cfg-model.test.ts — the PURE half of spec 25 §3 mode 3
// (docs/specs/26-ui-full-ide.md L9): `GET /api/fn/{fn}/cfg` rows in, the same
// `GraphModel` every other graph mode produces out. Runs in the root gate
// with no browser and no `ui/node_modules`, exactly like
// `tests/ui-core/graph-model.test.ts` (ui/src/graph/model.ts imports only
// TYPES from ui/src/contracts.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCfgModel, modelForLevel, blockNodeId, buildCallModel } from "../../ui/src/graph/model.ts";
import type { CfgBlock, CfgEdge, FnCfg } from "../../ui/src/contracts.ts";

function block(id: number, over: Partial<CfgBlock> = {}): CfgBlock {
  return {
    id,
    start: id * 10,
    end: id * 10 + 10,
    instructions: 3,
    terminator: "fallthrough",
    isHandlerEntry: false,
    entry: id === 0,
    exit: false,
    synthetic: false,
    lines: [id * 2 + 1, id * 2 + 2],
    fileLines: [id * 2 + 101, id * 2 + 102],
    ...over,
  };
}

function cfg(blocks: readonly CfgBlock[], edges: readonly CfgEdge[], over: Partial<FnCfg> = {}): FnCfg {
  return {
    fn: 5,
    entry: 0,
    fnStartLine: 100,
    blocks,
    edges,
    regions: [],
    total: blocks.length,
    shown: blocks.length,
    hidden: 0,
    truncated: false,
    cap: 300,
    ...over,
  };
}

test("buildCfgModel: one node per block, the entry is the focus", () => {
  const m = buildCfgModel({ fn: 5, cfg: cfg([block(0), block(1), block(2, { exit: true, terminator: "return" })], [
    { from: 0, to: 1, kind: "branch-taken" },
    { from: 0, to: 2, kind: "branch-not-taken" },
  ]) });
  assert.deepEqual(m.nodes.map((n) => n.id), [blockNodeId(0), blockNodeId(1), blockNodeId(2)]);
  assert.equal(m.nodes.filter((n) => n.isFocus).length, 1);
  assert.equal(m.nodes.find((n) => n.isFocus)!.id, blockNodeId(0));
  assert.ok(m.nodes.every((n) => n.kind === "block"));
  assert.equal(m.shown, 3);
  assert.equal(m.nodes[2]!.block!.exit, true);
});

test("buildCfgModel: a block node is never a function node (ids and kinds do not collide)", () => {
  const m = buildCfgModel({ fn: 3, cfg: cfg([block(3)], []) });
  assert.equal(m.nodes[0]!.id, "blk:3");
  assert.notEqual(m.nodes[0]!.id, "fn:3");
  assert.equal(m.nodes[0]!.kind, "block");
});

test("buildCfgModel: a click line is the module-file line when the route knew one, the function's own otherwise", () => {
  const withFile = buildCfgModel({ fn: 5, cfg: cfg([block(0)], []) });
  assert.equal(withFile.nodes[0]!.block!.listingLine, 101);
  const noFile = buildCfgModel({ fn: 5, cfg: cfg([block(0, { fileLines: null })], [], { fnStartLine: null }) });
  assert.equal(noFile.nodes[0]!.block!.listingLine, 1);
});

test("buildCfgModel: a block with no mapped line says so rather than borrowing a neighbour's", () => {
  const m = buildCfgModel({ fn: 5, cfg: cfg([block(0, { lines: null, fileLines: null }), block(1)], []) });
  assert.equal(m.nodes[0]!.block!.lines, null);
  assert.equal(m.nodes[0]!.block!.listingLine, null);
  assert.equal(m.nodes[1]!.block!.listingLine, 103);
});

test("buildCfgModel: every edge names a drawn block, and its kind and label survive", () => {
  const m = buildCfgModel({ fn: 5, cfg: cfg(
    [block(0), block(1)],
    [
      { from: 0, to: 1, kind: "branch-taken" },
      { from: 0, to: 9, kind: "jump" }, // block 9 was capped away server-side
      { from: 0, to: 1, kind: "switch-case", caseValue: 4 },
      { from: 1, to: 0, kind: "exception" },
    ],
  ) });
  const ids = new Set(m.nodes.map((n) => n.id));
  assert.ok(m.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
  assert.equal(m.edges.length, 3);
  assert.deepEqual(m.edges.map((e) => e.cfgKind), ["branch-taken", "switch-case", "exception"]);
  assert.deepEqual(m.edges.map((e) => e.cfgLabel), ["T", "case 4", "exc"]);
  // An exception edge is proven control flow, never flagged as a heuristic
  // by-name candidate (which is what `byName` means everywhere else).
  assert.ok(m.edges.every((e) => !e.byName));
});

test("buildCfgModel: the server's truncation is carried through, never re-derived", () => {
  const m = buildCfgModel({ fn: 5, cfg: cfg([block(0)], [], { total: 51, hidden: 50, truncated: true, shown: 1 }) });
  assert.equal(m.hidden, 50);
  assert.equal(m.total, 51);
  assert.equal(m.shown, 1);
});

test("modelForLevel: near draws the CFG when there is one, and the fetched neighbourhood when there is not", () => {
  const calls = buildCallModel({
    focus: 5,
    focusLabel: "fn5",
    focusSize: null,
    focusModule: null,
    hops: [{ fn: 5, callers: [], callees: [], byName: [] }],
    expanded: new Set<number>(),
    severityOf: () => null,
  });
  const blocks = buildCfgModel({ fn: 5, cfg: cfg([block(0), block(1)], [{ from: 0, to: 1, kind: "fallthrough" }]) });
  assert.equal(modelForLevel(calls, "near", blocks), blocks);
  assert.equal(modelForLevel(calls, "near", null), calls);
  assert.equal(modelForLevel(calls, "near"), calls);
  // A CFG the route answered with no blocks at all is not a drawable graph.
  assert.equal(modelForLevel(calls, "near", buildCfgModel({ fn: 5, cfg: cfg([], []) })), calls);
  // The other two levels are untouched by L9.
  assert.equal(modelForLevel(calls, "mid", blocks), calls);
  assert.notEqual(modelForLevel(calls, "far", blocks), blocks);
});
