// ui/src/graph/layout.ts — layered layout for the graph pane (spec 25 §5,
// §5c; D28). Pure: model + frame in, positions out. Top-down, so callers sit
// above the focus and callees below it, which is the shape an analyst reads a
// call graph in.
//
// Bur 11 (spec 25 §5c): the pane is ~280 px wide and much taller than wide.
// Plain dagre spreads a rank of callees across ~1000 px, so `fitView` scales
// the whole neighbourhood down to ~0.25 and nothing is legible. The fix is to
// lay out FOR THE MEASURED FRAME: dagre still decides the ranks and the
// left-to-right order inside each rank (that is its crossing minimisation,
// which is the part worth keeping), and then each rank is re-packed into rows
// that wrap at the widest grid the frame can hold at a legible node width.
import { Graph, layout as dagreLayout } from "@dagrejs/dagre";
import type { GraphModel } from "./model.ts";

/** Node box, in CSS pixels. `NODE_W` is the PREFERRED width and the widest a
 *  node is ever drawn; a narrow frame shrinks it towards `NODE_W_MIN`, below
 *  which a mono label stops being readable. Whatever this module returns as
 *  `nodeWidth`, the custom node renders at (ui/src/graph/nodes.tsx) — the two
 *  must not disagree or dagre's spacing lies. */
export const NODE_W = 176;
export const NODE_W_MIN = 104;
export const NODE_H = 44;
/** The focus node's height at the `near` LOD level, where it opens into a
 *  card (spec 25 §5b). dagre must know, or the rank below it overlaps. */
export const NODE_H_NEAR = 140;

/** Gaps used by the framed layout (§5c). `ROW_GAP` separates the wrapped rows
 *  INSIDE one rank; `RANK_GAP` separates the ranks themselves, and stays the
 *  larger of the two so a wrapped rank still reads as one rank. */
export const GAP_X = 12;
export const ROW_GAP = 10;
export const RANK_GAP = 34;
export const MARGIN = 8;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface LayoutOptions {
  /** Height to use for the focus node instead of `NODE_H` - the `near`
   *  level's opened card (spec 25 §5b). */
  readonly focusHeight?: number;
  /** The pane's measured content box (`ResizeObserver` in `GraphPane`).
   *  Omitted/degenerate = the unframed dagre layout, exactly as before bur
   *  11: the first render, before the observer has reported, must still draw
   *  something sane. */
  readonly frame?: Size | null;
}

/** Position of every node in `model`, keyed by node id, plus the geometry the
 *  pane needs to render at the same size the layout assumed. React Flow
 *  places a node by its TOP-LEFT corner; dagre reports its CENTRE, so we
 *  shift. */
export interface GraphLayout {
  readonly positions: ReadonlyMap<string, Point>;
  /** The width every node must be drawn at for this layout to hold. */
  readonly nodeWidth: number;
  /** Nodes per row before a rank wraps (>= 1); `0` when there was no frame
   *  to lay out for, i.e. the unwrapped dagre placement. */
  readonly columns: number;
  /** Bounding box of the laid-out neighbourhood, margins included. With a
   *  frame, `width` is <= the frame's width by construction — that is the
   *  whole point of bur 11 and is asserted in the tests. */
  readonly width: number;
  readonly height: number;
}

export interface RankedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly h: number;
}

function heightOf(isFocus: boolean, options: LayoutOptions): number {
  return isFocus ? options.focusHeight ?? NODE_H : NODE_H;
}

/** Chunk a rank into rows of at most `columns`. */
function rowsOf<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return rows;
}

/** Total height a wrapped layout would occupy at `columns` columns. */
function heightAt(ranks: readonly (readonly RankedNode[])[], columns: number): number {
  let h = MARGIN * 2;
  ranks.forEach((rank, i) => {
    const rows = rowsOf(rank, columns);
    const rowH = rank.reduce((m, n) => Math.max(m, n.h), NODE_H);
    h += rows.length * rowH + (rows.length - 1) * ROW_GAP;
    if (i < ranks.length - 1) h += RANK_GAP;
  });
  return h;
}

function widthAt(columns: number, nodeWidth: number): number {
  return columns * nodeWidth + (columns - 1) * GAP_X;
}

function nodeWidthFor(columns: number, budget: number): number {
  const raw = (budget - (columns - 1) * GAP_X) / columns;
  return Math.max(NODE_W_MIN, Math.min(NODE_W, Math.floor(raw)));
}

/** §5c's grid choice, pure and separately testable.
 *
 *  The objective is the one thing that actually matters for bur 11: how big a
 *  node is ON SCREEN after `fitView`. For a candidate column count that is
 *  `nodeWidth * scale`, where `scale = min(frameW / boxW, frameH / boxH)`
 *  capped at 1 (React Flow's `fitView` never blows a small graph up past its
 *  natural size here). One column keeps the widest nodes but a tall box; many
 *  columns keep the box square but narrow the nodes - maximising the product
 *  picks whichever wins for THIS frame, which is why a 280 px side panel and
 *  a maximised window get different answers from the same code. Ties (both
 *  fit at 1:1) go to the box whose aspect ratio is closest to the frame's, so
 *  the fewest wrapped rows (an unwrapped rank reads as a rank, so wrapping is
 *  only ever paid for when it buys legibility), and then to the box whose
 *  aspect ratio is closest to the frame's. */
export function chooseGrid(
  ranks: readonly (readonly RankedNode[])[],
  frame: Size,
): { readonly columns: number; readonly nodeWidth: number } {
  const budget = Math.max(NODE_W_MIN, frame.width - MARGIN * 2);
  const widest = ranks.reduce((m, r) => Math.max(m, r.length), 1);
  const colsMax = Math.max(1, Math.min(widest, Math.floor((budget + GAP_X) / (NODE_W_MIN + GAP_X))));
  const frameAspect = frame.height > 0 ? frame.width / frame.height : 1;
  let best = { columns: 1, nodeWidth: nodeWidthFor(1, budget) };
  let bestScore = -1;
  let bestRows = Infinity;
  let bestAspect = Infinity;
  for (let columns = 1; columns <= colsMax; columns++) {
    const nodeWidth = nodeWidthFor(columns, budget);
    const boxW = widthAt(columns, nodeWidth) + MARGIN * 2;
    const boxH = Math.max(1, heightAt(ranks, columns));
    const scale = Math.min(1, frame.width / boxW, Math.max(frame.height, 1) / boxH);
    const score = Math.round(nodeWidth * scale * 100) / 100;
    const rows = ranks.reduce((n, r) => n + Math.ceil(r.length / columns), 0);
    const aspect = Math.abs(Math.log(boxW / boxH / (frameAspect || 1)));
    const better =
      score > bestScore ||
      (score === bestScore && (rows < bestRows || (rows === bestRows && aspect < bestAspect)));
    if (better) {
      best = { columns, nodeWidth };
      bestScore = score;
      bestRows = rows;
      bestAspect = aspect;
    }
  }
  return best;
}

/** Rank the model with dagre and keep its ordering; the caller decides the
 *  geometry. All nodes of one dagre rank share one centre `y`, which is what
 *  groups them here. */
function rankModel(model: GraphModel, options: LayoutOptions): RankedNode[][] {
  const g = new Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 64, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of model.nodes) g.setNode(n.id, { width: NODE_W, height: heightOf(n.isFocus, options) });
  for (const e of model.edges) g.setEdge(e.source, e.target, {}, e.id);
  dagreLayout(g);
  const byRank = new Map<number, RankedNode[]>();
  for (const n of model.nodes) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined;
    const p: RankedNode = { id: n.id, x: laid?.x ?? 0, y: laid?.y ?? 0, h: heightOf(n.isFocus, options) };
    const key = Math.round(p.y);
    const bucket = byRank.get(key);
    if (bucket === undefined) byRank.set(key, [p]);
    else bucket.push(p);
  }
  return [...byRank.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, rank]) => [...rank].sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1)));
}

/** The full layout. Without a frame this is the plain dagre placement that
 *  shipped with spec 25 §5; with one it is §5c's wrapped grid. */
export function layoutGraph(model: GraphModel, options: LayoutOptions = {}): GraphLayout {
  const ranks = rankModel(model, options);
  const frame = options.frame ?? null;
  if (frame === null || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0) {
    const positions = new Map<string, Point>();
    let maxX = 0;
    let maxY = 0;
    for (const rank of ranks) {
      for (const p of rank) {
        positions.set(p.id, { x: p.x - NODE_W / 2, y: p.y - p.h / 2 });
        maxX = Math.max(maxX, p.x + NODE_W / 2);
        maxY = Math.max(maxY, p.y + p.h / 2);
      }
    }
    return { positions, nodeWidth: NODE_W, columns: 0, width: maxX + MARGIN, height: maxY + MARGIN };
  }

  const { columns, nodeWidth } = chooseGrid(ranks, frame);
  const contentW = widthAt(columns, nodeWidth);
  const positions = new Map<string, Point>();
  let y = MARGIN;
  ranks.forEach((rank, i) => {
    const rows = rowsOf(rank, columns);
    const rowH = rank.reduce((m, n) => Math.max(m, n.h), NODE_H);
    for (const row of rows) {
      // Rows are CENTRED inside the content box, so a rank of one (the focus,
      // usually) sits over the middle of the rank above and below it rather
      // than hugging the left edge.
      const rowW = widthAt(row.length, nodeWidth);
      const x0 = MARGIN + Math.round((contentW - rowW) / 2);
      row.forEach((p, c) => {
        positions.set(p.id, { x: x0 + c * (nodeWidth + GAP_X), y: y + Math.round((rowH - p.h) / 2) });
      });
      y += rowH + ROW_GAP;
    }
    y -= ROW_GAP;
    if (i < ranks.length - 1) y += RANK_GAP;
  });
  return { positions, nodeWidth, columns, width: contentW + MARGIN * 2, height: y + MARGIN };
}

/** Positions only — the shape the pane used before bur 11, kept because most
 *  callers and tests only ever want the map. */
export function layoutModel(model: GraphModel, options: LayoutOptions = {}): ReadonlyMap<string, Point> {
  return layoutGraph(model, options).positions;
}
