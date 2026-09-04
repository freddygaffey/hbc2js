// ui/src/graph/layout.ts — dagre layered layout (spec 25 §5, D28). Pure:
// model in, positions out. Top-down, so callers sit above the focus and
// callees below it, which is the shape an analyst reads a call graph in.
import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { GraphModel } from "./model.ts";

/** Node box, in CSS pixels. Must match the custom node's rendered size
 *  (ui/src/graph/nodes.tsx) or dagre's spacing lies. */
export const NODE_W = 176;
export const NODE_H = 44;
/** The focus node's height at the `near` LOD level, where it opens into a
 *  card (spec 25 §5b). dagre must know, or the rank below it overlaps. */
export const NODE_H_NEAR = 140;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Position of every node in `model`, keyed by node id. React Flow places a
 *  node by its TOP-LEFT corner; dagre reports its CENTRE, so we shift. */
export interface LayoutOptions {
  /** Height to use for the focus node instead of `NODE_H` - the `near`
   *  level's opened card (spec 25 §5b). */
  readonly focusHeight?: number;
}

export function layoutModel(model: GraphModel, options: LayoutOptions = {}): ReadonlyMap<string, Point> {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 64, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of model.nodes) {
    g.setNode(n.id, { width: NODE_W, height: n.isFocus ? options.focusHeight ?? NODE_H : NODE_H });
  }
  for (const e of model.edges) g.setEdge(e.source, e.target, {}, e.id);
  dagreLayout(g);
  const out = new Map<string, Point>();
  for (const n of model.nodes) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined;
    const h = n.isFocus ? options.focusHeight ?? NODE_H : NODE_H;
    out.set(n.id, { x: (laid?.x ?? 0) - NODE_W / 2, y: (laid?.y ?? 0) - h / 2 });
  }
  return out;
}
