// tests/ui-core/graph-model.test.ts — spec 25 §6 acceptance: the graph
// view's PURE model (ui/src/graph/model.ts). It imports only types from
// ui/src/contracts.ts, so it runs under node:test with no ui/node_modules
// and no browser — which is why the cap/truncation rule is checked here
// rather than in Playwright (no fixture function has 300 neighbours).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCallModel, buildModuleModel, GRAPH_NODE_CAP, type CallHop,
} from "../../ui/src/graph/model.ts";
import type { ByNameCaller, XrefEdge } from "../../ui/src/contracts.ts";

function edge(fn: number | string, name: string | null = null): XrefEdge {
  return { fn, name, size: null, file: null, line: null, kind: "call" };
}

function byName(fn: number): ByNameCaller {
  return { fn, callerName: null, size: null, name: "handle", role: "property-get", n: 1, file: null, line: null, confidence: "by-name" };
}

function hop(fn: number, callers: readonly XrefEdge[], callees: readonly XrefEdge[], candidates: readonly ByNameCaller[] = []): CallHop {
  return { fn, callers, callees, byName: candidates };
}

test("call neighbourhood: focus + callers above + callees below, one hop", () => {
  const m = buildCallModel({
    focus: 7,
    focusLabel: "handleTap",
    focusSize: 120,
    focusModule: 3,
    hops: [hop(7, [edge(1, "a"), edge(2, "b")], [edge(9, "c")])],
    expanded: new Set<number>(),
  });
  assert.equal(m.shown, 4);
  assert.equal(m.hidden, 0);
  assert.equal(m.nodes.filter((n) => n.isFocus).length, 1);
  assert.equal(m.nodes.find((n) => n.isFocus)?.id, "fn:7");
  assert.deepEqual(
    m.edges.map((e) => `${e.source}->${e.target}`).sort(),
    ["fn:1->fn:7", "fn:2->fn:7", "fn:7->fn:9"],
  );
  assert.ok(m.edges.every((e) => !e.byName));
});

test("by-name candidates are dashed edges and never outrank a resolved edge", () => {
  const m = buildCallModel({
    focus: 7,
    focusLabel: "f",
    focusSize: null,
    focusModule: null,
    // fn 1 arrives BOTH as a heuristic candidate and as a proven caller.
    hops: [hop(7, [edge(1, "a")], [], [byName(1), byName(5)])],
    expanded: new Set<number>(),
  });
  assert.equal(m.nodes.find((n) => n.id === "fn:1")?.byName, false, "a proven caller is never downgraded to a candidate");
  assert.equal(m.nodes.find((n) => n.id === "fn:5")?.byName, true);
  const dashed = m.edges.filter((e) => e.byName).map((e) => e.source).sort();
  assert.deepEqual(dashed, ["fn:1", "fn:5"]);
});

test("a native/unknown neighbour (string fn) is drawn but not navigable", () => {
  const m = buildCallModel({
    focus: 7, focusLabel: "f", focusSize: null, focusModule: null,
    hops: [hop(7, [], [edge("native", "Date.now")])],
    expanded: new Set<number>(),
  });
  const ext = m.nodes.find((n) => n.id.startsWith("ext:"));
  assert.ok(ext !== undefined, "the unresolved callee is still drawn");
  assert.equal(ext.ref, -1, "no fn index -> not navigable");
});

test("the node cap drops the overflow and reports it honestly (truncation bar)", () => {
  const callees = Array.from({ length: GRAPH_NODE_CAP + 50 }, (_, i) => edge(1000 + i, `c${i}`));
  const m = buildCallModel({
    focus: 7, focusLabel: "f", focusSize: null, focusModule: null,
    hops: [hop(7, [], callees)],
    expanded: new Set<number>(),
  });
  assert.equal(m.shown, GRAPH_NODE_CAP);
  assert.equal(m.hidden, 51, "focus + 350 callees = 351 nodes, 300 drawn");
  assert.equal(m.total, GRAPH_NODE_CAP + 51);
  assert.ok(m.edges.every((e) => m.nodes.some((n) => n.id === e.source) && m.nodes.some((n) => n.id === e.target)),
    "an edge to a capped-away node is dropped with it");
});

test("module mode draws DIRECT deps/consumers only (spec 17 §14 cut module-graph)", () => {
  const m = buildModuleModel({ focus: 4, deps: [5, 6], dependents: [2] });
  assert.equal(m.shown, 4);
  assert.deepEqual(
    m.edges.map((e) => `${e.source}->${e.target}`).sort(),
    ["mod:2->mod:4", "mod:4->mod:5", "mod:4->mod:6"],
  );
  assert.ok(m.nodes.every((n) => n.kind === "module"));
});
