// tests/ui-core/graph-layout.test.ts — bur 11 / spec 25 §5c: the graph pane
// lays itself out FOR ITS FRAME. `layoutGraph` is pure (model + frame in,
// positions out), so the whole thing is testable without a browser: build a
// neighbourhood, hand it the docked pane's real box (~280 x 700), and assert
// the laid-out bounding box fits inside it at a legible node width.
//
// Fred, bur 11: "you can't see everything when zoomed out because it is too
// wide for the small frame that you have."
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCallModel, type CallHop } from "../../ui/src/graph/model.ts";
import {
  layoutGraph, layoutModel, MARGIN, NODE_H, NODE_H_NEAR, NODE_W, NODE_W_MIN,
} from "../../ui/src/graph/layout.ts";
import type { XrefEdge } from "../../ui/src/contracts.ts";

/** The docked right pane (spec 25 §4: "a call neighbourhood does not read
 *  well at 280 px" — this is that 280 px). */
const PANE = { width: 280, height: 700 };
/** The maximised overlay, a normal laptop window. */
const WINDOW = { width: 1280, height: 760 };

function edge(fn: number): XrefEdge {
  return { fn, name: `f${fn}`, size: 10, module: 1, file: null, line: null, kind: "call" };
}

/** A focus with `callers` callers and `callees` callees, one hop. */
function model(callers: number, callees: number) {
  const hop: CallHop = {
    fn: 1,
    callers: Array.from({ length: callers }, (_, i) => edge(100 + i)),
    callees: Array.from({ length: callees }, (_, i) => edge(200 + i)),
    byName: [],
  };
  return buildCallModel({
    focus: 1, focusLabel: "focus", focusSize: null, focusModule: 1,
    hops: [hop], expanded: new Set<number>(),
  });
}

function extent(layout: ReturnType<typeof layoutGraph>): { readonly w: number; readonly h: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of layout.positions.values()) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x + layout.nodeWidth);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y + NODE_H);
  }
  return { w: maxX - minX, h: maxY - minY };
}

test("bur 11: a wide rank wraps so the neighbourhood fits the docked pane's width", () => {
  const m = model(2, 8);
  const before = layoutGraph(m, {});
  // The bug, reproduced: unframed, one rank of eight is over a thousand
  // pixels wide in a 280 px pane, which is why fit-to-view made it unreadable.
  assert.ok(extent(before).w > PANE.width * 3, `unframed extent ${extent(before).w} should be far wider than the pane`);

  const after = layoutGraph(m, { frame: PANE });
  assert.ok(extent(after).w <= PANE.width, `framed extent ${extent(after).w} must fit ${PANE.width}`);
  assert.ok(after.width <= PANE.width, `layout width ${after.width} must fit ${PANE.width}`);
  assert.equal(after.positions.size, m.nodes.length);
});

test("bur 11: nodes stay at a legible width, never squeezed below NODE_W_MIN", () => {
  for (const callees of [1, 3, 8, 40]) {
    const l = layoutGraph(model(2, callees), { frame: PANE });
    assert.ok(l.nodeWidth >= NODE_W_MIN, `nodeWidth ${l.nodeWidth} below the legible minimum`);
    assert.ok(l.nodeWidth <= NODE_W, `nodeWidth ${l.nodeWidth} above the preferred width`);
    assert.ok(l.columns >= 1);
  }
});

test("bur 11: a roomy frame keeps the preferred node width and does not wrap", () => {
  const m = model(2, 5);
  const l = layoutGraph(m, { frame: WINDOW });
  assert.equal(l.nodeWidth, NODE_W, "a 1280 px window has no reason to narrow the nodes");
  assert.ok(l.columns >= 5, `a rank of five should not wrap in a 1280 px window (columns=${l.columns})`);
  assert.ok(extent(l).w <= WINDOW.width);
});

test("bur 11: the vertical flow survives wrapping - callers above the focus, callees below", () => {
  const m = model(3, 9);
  const l = layoutGraph(m, { frame: PANE });
  const focusY = l.positions.get("fn:1")?.y ?? 0;
  for (const n of m.nodes) {
    if (n.isFocus) continue;
    const y = l.positions.get(n.id)?.y ?? 0;
    const isCaller = n.ref >= 100 && n.ref < 200;
    if (isCaller) assert.ok(y < focusY, `caller ${n.id} (y=${y}) must sit above the focus (y=${focusY})`);
    else assert.ok(y > focusY, `callee ${n.id} (y=${y}) must sit below the focus (y=${focusY})`);
  }
});

test("bur 11: wrapped rows never overlap - every node box is disjoint", () => {
  const l = layoutGraph(model(5, 13), { frame: PANE });
  const boxes = [...l.positions.values()].map((p) => ({ x: p.x, y: p.y, w: l.nodeWidth, h: NODE_H }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlaps, `boxes ${i} and ${j} overlap: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
});

test("bur 11: the near level's taller focus card is reserved for, not overlapped", () => {
  const m = model(2, 4);
  const l = layoutGraph(m, { frame: PANE, focusHeight: NODE_H_NEAR });
  const focus = l.positions.get("fn:1");
  assert.ok(focus !== undefined);
  for (const n of m.nodes) {
    if (n.isFocus) continue;
    const p = l.positions.get(n.id)!;
    const clear = p.y + NODE_H <= focus.y || p.y >= focus.y + NODE_H_NEAR;
    assert.ok(clear, `${n.id} at y=${p.y} collides with the near-level focus card (${focus.y}..${focus.y + NODE_H_NEAR})`);
  }
});

test("bur 11: no frame (first render, before the observer reports) keeps the old dagre layout", () => {
  const m = model(2, 3);
  const framed = layoutGraph(m, { frame: null });
  const plain = layoutModel(m);
  assert.deepEqual([...plain.entries()].sort(), [...framed.positions.entries()].sort());
  assert.equal(framed.nodeWidth, NODE_W);
});

test("bur 11: a degenerate frame (zero/NaN width) degrades to the unframed layout, never NaN positions", () => {
  const m = model(1, 2);
  for (const frame of [{ width: 0, height: 0 }, { width: Number.NaN, height: 100 }]) {
    const l = layoutGraph(m, { frame });
    for (const p of l.positions.values()) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `non-finite position ${JSON.stringify(p)}`);
    }
    assert.equal(l.positions.size, m.nodes.length);
  }
});

test("bur 11: positions are non-negative and inside the reported bounding box", () => {
  const l = layoutGraph(model(4, 7), { frame: PANE });
  for (const p of l.positions.values()) {
    assert.ok(p.x >= 0 && p.y >= 0, `position ${JSON.stringify(p)} outside the box`);
    assert.ok(p.x + l.nodeWidth <= l.width - MARGIN + 1, `node right edge ${p.x + l.nodeWidth} beyond ${l.width}`);
    assert.ok(p.y + NODE_H <= l.height + 1, `node bottom edge ${p.y + NODE_H} beyond ${l.height}`);
  }
});

test("bur 11: the layout is deterministic - same model and frame, same positions", () => {
  const m = model(3, 6);
  const a = layoutGraph(m, { frame: PANE });
  const b = layoutGraph(m, { frame: PANE });
  assert.deepEqual([...a.positions.entries()], [...b.positions.entries()]);
  assert.equal(a.nodeWidth, b.nodeWidth);
});

test("bur 11: every frame width produces a layout that fits inside it", () => {
  const m = model(3, 10);
  for (const width of [220, 280, 420, 640, 1280]) {
    const l = layoutGraph(m, { frame: { width, height: 700 } });
    assert.ok(l.width <= Math.max(width, NODE_W_MIN + MARGIN * 2), `layout ${l.width} wider than frame ${width}`);
    assert.ok(l.nodeWidth >= NODE_W_MIN && l.nodeWidth <= NODE_W);
  }
});
