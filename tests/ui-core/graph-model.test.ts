// tests/ui-core/graph-model.test.ts — spec 25 §6 acceptance: the graph
// view's PURE model (ui/src/graph/model.ts). It imports only types from
// ui/src/contracts.ts, so it runs under node:test with no ui/node_modules
// and no browser — which is why the cap/truncation rule is checked here
// rather than in Playwright (no fixture function has 300 neighbours).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCallModel, buildModuleModel, bundleByModule, calleeNodeForSelection, GRAPH_NODE_CAP, lodCard, lodLevel,
  LOD_HYSTERESIS, LOD_LEVELS, LOD_NOMINAL_ZOOM, LOD_THRESHOLDS, modelForLevel, neighbourSet, nextLodLevel,
  type CallHop,
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

// Bur 8 (2026-09-05): hover/selection highlight — the pure neighbour-set
// helper the pane dims everything else against.
test("neighbourSet: a node plus its incident edges/nodes, nothing further", () => {
  const m = buildCallModel({
    focus: 7, focusLabel: "f", focusSize: null, focusModule: null,
    hops: [
      hop(7, [edge(1, "a")], [edge(2, "b")]),
      hop(2, [], [edge(9, "grandchild")]),
    ],
    expanded: new Set<number>([2]),
  });
  const ns = neighbourSet(m, "fn:7");
  assert.deepEqual([...ns.nodes].sort(), ["fn:1", "fn:2", "fn:7"]);
  assert.deepEqual([...ns.edges].sort(), ["e:fn:1->fn:7", "e:fn:7->fn:2"]);
  // fn:9 is two hops from fn:7 (via fn:2) — never in fn:7's neighbour set.
  assert.ok(!ns.nodes.has("fn:9"));
});

test("neighbourSet: an isolated node (no edges) is just itself", () => {
  const m = buildModuleModel({ focus: 4, deps: [], dependents: [] });
  const ns = neighbourSet(m, "mod:4");
  assert.deepEqual([...ns.nodes], ["mod:4"]);
  assert.equal(ns.edges.size, 0);
});

// Bur 10 (2026-09-05): the follow toggle's call-site highlight — resolves a
// listing selection to one of the graph's own drawn neighbours, or null.
test("calleeNodeForSelection: an identifier inside the focus fn matching a drawn callee", () => {
  const m = buildCallModel({
    focus: 7, focusLabel: "f", focusSize: null, focusModule: null,
    hops: [hop(7, [], [edge(9, "helper")])],
    expanded: new Set<number>(),
  });
  assert.equal(calleeNodeForSelection(m, { kind: "identifier", fn: 7, name: "helper" }), "fn:9");
});

test("calleeNodeForSelection: null for a non-identifier selection, a different fn, or no match", () => {
  const m = buildCallModel({
    focus: 7, focusLabel: "f", focusSize: null, focusModule: null,
    hops: [hop(7, [], [edge(9, "helper")])],
    expanded: new Set<number>(),
  });
  assert.equal(calleeNodeForSelection(m, { kind: "fn", fn: 7, name: "helper" }), null, "not an identifier selection");
  assert.equal(calleeNodeForSelection(m, { kind: "identifier", fn: 99, name: "helper" }), null, "selection is in a different function");
  assert.equal(calleeNodeForSelection(m, { kind: "identifier", fn: 7, name: "nope" }), null, "no drawn neighbour has that name");
  assert.equal(calleeNodeForSelection(m, { kind: "identifier", fn: 7, name: "f" }), null, "never the focus itself");
});

// -- bur 9 (docs/UI-BURS.md #9; spec 25 §5b): semantic zoom -----------------

test("lodLevel: the three levels, by viewport zoom", () => {
  assert.equal(lodLevel(0.2, "mid"), "far");
  assert.equal(lodLevel(0.9, "mid"), "mid");
  assert.equal(lodLevel(3, "mid"), "near");
  // A jump straight past two boundaries lands on the right level, not the
  // adjacent one: the function is of the zoom, not of the step taken.
  assert.equal(lodLevel(3, "far"), "near");
  assert.equal(lodLevel(0.1, "near"), "far");
  // Not a number (a viewport that has not been measured) keeps the level.
  assert.equal(lodLevel(Number.NaN, "near"), "near");
});

test("lodLevel: hysteresis - a zoom sitting on a boundary keeps the level it had", () => {
  const t = LOD_THRESHOLDS.farMid;
  // Inside the band around the threshold, BOTH answers are "whatever it
  // already was" - which is exactly what stops the view flickering.
  for (const z of [t * (1 - LOD_HYSTERESIS / 2), t, t * (1 + LOD_HYSTERESIS / 2)]) {
    assert.equal(lodLevel(z, "far"), "far", `zoom ${z} should stay far`);
    assert.equal(lodLevel(z, "mid"), "mid", `zoom ${z} should stay mid`);
  }
  // Outside the band it commits, whatever it had.
  assert.equal(lodLevel(t * (1 + LOD_HYSTERESIS * 1.01), "far"), "mid");
  assert.equal(lodLevel(t * (1 - LOD_HYSTERESIS * 1.01), "mid"), "far");
  const u = LOD_THRESHOLDS.midNear;
  assert.equal(lodLevel(u, "mid"), "mid");
  assert.equal(lodLevel(u, "near"), "near");
  assert.equal(lodLevel(u * (1 + LOD_HYSTERESIS * 1.01), "mid"), "near");
  assert.equal(lodLevel(u * (1 - LOD_HYSTERESIS * 1.01), "near"), "mid");
});

test("lodLevel: every nominal zoom derives its own level (a set level cannot fight the viewport)", () => {
  for (const level of LOD_LEVELS) {
    for (const prev of LOD_LEVELS) {
      assert.equal(lodLevel(LOD_NOMINAL_ZOOM[level], prev), level, `${level} nominal from ${prev}`);
    }
  }
});

test("nextLodLevel cycles far -> mid -> near -> far", () => {
  assert.equal(nextLodLevel("far"), "mid");
  assert.equal(nextLodLevel("mid"), "near");
  assert.equal(nextLodLevel("near"), "far");
});

test("bundleByModule: functions fold into their module, parallel edges bundle with a weight", () => {
  const m = buildCallModel({
    focus: 1,
    focusLabel: "focus",
    focusSize: null,
    focusModule: 5,
    hops: [{
      fn: 1,
      callers: [],
      callees: [
        { fn: 2, name: "a", size: 10, module: 7 },
        { fn: 3, name: "b", size: 20, module: 7 },
        { fn: 4, name: "c", size: 5, module: 8 },
      ] as never,
      byName: [],
    }],
    expanded: new Set<number>(),
  });
  const far = bundleByModule(m);
  const ids = far.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["mod:5", "mod:7", "mod:8"]);
  const seven = far.nodes.find((n) => n.id === "mod:7")!;
  assert.equal(seven.members, 2, "two functions folded into module 7");
  assert.equal(seven.kind, "module");
  assert.equal(seven.size, 30, "the bundle reports the members' total size");
  assert.ok(far.nodes.find((n) => n.id === "mod:5")?.isFocus, "the focus's module carries the focus");
  const bundled = far.edges.find((e) => e.source === "mod:5" && e.target === "mod:7");
  assert.equal(bundled?.weight, 2, "two fn->fn edges bundle into one module edge of weight 2");
  assert.equal(far.edges.find((e) => e.target === "mod:8")?.weight, 1);
  assert.equal(far.edges.length, 2);
});

test("bundleByModule: a function with no known module is never guessed into someone else's", () => {
  const m = buildCallModel({
    focus: 1,
    focusLabel: "focus",
    focusSize: null,
    focusModule: null,
    hops: [{ fn: 1, callers: [], callees: [{ fn: 2, name: "a", size: null, module: 7 }] as never, byName: [] }],
    expanded: new Set<number>(),
  });
  const far = bundleByModule(m);
  assert.deepEqual(far.nodes.map((n) => n.id).sort(), ["fn:1", "mod:7"]);
  assert.equal(far.nodes.find((n) => n.id === "fn:1")?.members, 1);
  // The cap's honest count survives the bundle.
  assert.equal(far.hidden, m.hidden);
});

test("bundleByModule: an intra-module edge is not drawn as a self-loop at far", () => {
  const m = buildCallModel({
    focus: 1,
    focusLabel: "focus",
    focusSize: null,
    focusModule: 7,
    hops: [{ fn: 1, callers: [], callees: [{ fn: 2, name: "a", size: null, module: 7 }] as never, byName: [] }],
    expanded: new Set<number>(),
  });
  const far = bundleByModule(m);
  assert.deepEqual(far.nodes.map((n) => n.id), ["mod:7"]);
  assert.equal(far.edges.length, 0, "an edge inside one module is what the MID level draws");
});

test("modelForLevel: mid and near draw the fetched model, far bundles it", () => {
  const m = buildCallModel({
    focus: 1,
    focusLabel: "focus",
    focusSize: null,
    focusModule: 5,
    hops: [{ fn: 1, callers: [], callees: [{ fn: 2, name: "a", size: null, module: 7 }] as never, byName: [] }],
    expanded: new Set<number>(),
  });
  assert.equal(modelForLevel(m, "mid"), m);
  assert.equal(modelForLevel(m, "near"), m);
  assert.deepEqual(modelForLevel(m, "far").nodes.map((n) => n.id).sort(), ["mod:5", "mod:7"]);
});

test("lodCard: the near level's focus card lists drawn callers/callees, bounded", () => {
  const callers = Array.from({ length: 11 }, (_, i) => ({ fn: 100 + i, name: `c${i}`, size: null, module: null }));
  const m = buildCallModel({
    focus: 1,
    focusLabel: "focus",
    focusSize: null,
    focusModule: null,
    hops: [{ fn: 1, callers: callers as never, callees: [{ fn: 2, name: "out", size: null, module: null }] as never, byName: [] }],
    expanded: new Set<number>(),
  });
  const card = lodCard(m, "fn:1", 3);
  assert.deepEqual([...card.callers], ["c0", "c1", "c2"]);
  assert.equal(card.moreCallers, 8, "the overflow is stated, never silently dropped");
  assert.deepEqual([...card.callees], ["out"]);
  assert.equal(card.moreCallees, 0);
  // The card can only ever say what the model already draws.
  assert.ok(card.callers.every((label) => m.nodes.some((n) => n.label === label)));
});

test("lodCard: a node with no drawn edges says so rather than inventing any", () => {
  const m = buildModuleModel({ focus: 4, deps: [], dependents: [] });
  const card = lodCard(m, "mod:4");
  assert.equal(card.callers.length, 0);
  assert.equal(card.callees.length, 0);
});
