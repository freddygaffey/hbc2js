// ui/src/graph/layout.ts — dagre layered layout (spec 25 §5, D28). Pure:
// model in, positions out. Top-down, so callers sit above the focus and
// callees below it, which is the shape an analyst reads a call graph in.
import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { GraphModel } from "./model.ts";

/** Node box, in CSS pixels. Must match the custom node's rendered size
 *  (ui/src/graph/nodes.tsx) or dagre's spacing lies. */
export const NODE_W = 176;
export const NODE_H = 44;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Position of every node in `model`, keyed by node id. React Flow places a
 *  node by its TOP-LEFT corner; dagre reports its CENTRE, so we shift. */
export function layoutModel(model: GraphModel): ReadonlyMap<string, Point> {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 64, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of model.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of model.edges) g.setEdge(e.source, e.target, {}, e.id);
  dagreLayout(g);
  const out = new Map<string, Point>();
  for (const n of model.nodes) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined;
    out.set(n.id, { x: (laid?.x ?? 0) - NODE_W / 2, y: (laid?.y ?? 0) - NODE_H / 2 });
  }
  return out;
}
