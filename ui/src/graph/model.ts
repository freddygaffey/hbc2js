// ui/src/graph/model.ts — the PURE half of the graph view (spec 25 §3/§5):
// xref/module contract rows in, a capped node/edge model out. No React, no
// dagre, no fetching — everything here is testable with plain data, and the
// cap is applied here so the pane can never draw more than it promises.
import type { ByNameCaller, Severity, XrefEdge } from "../contracts.ts";

/** Spec 25 §5: the hard ceiling on drawn nodes. Above it the extra nodes are
 *  dropped and the pane shows a truncation bar — never a silent trim. */
export const GRAPH_NODE_CAP = 300;

export type GraphKind = "fn" | "module";

export interface GraphNodeModel {
  /** Stable React Flow id: `fn:12`, `mod:3`, or `ext:<name>` for a
   *  native/unknown neighbour that has no function index. */
  readonly id: string;
  readonly kind: GraphKind;
  /** The fn/module index, or `-1` for an `ext:` node (not navigable). */
  readonly ref: number;
  readonly label: string;
  readonly size: number | null;
  readonly module: number | null;
  readonly severity: Severity | null;
  readonly isFocus: boolean;
  /** Reached ONLY through a by-name candidate edge (spec 17 §14.1): a name
   *  match, never a proven caller. Drawn lighter, like the Xrefs pane's. */
  readonly byName: boolean;
  readonly expanded: boolean;
  /** How many source nodes this node stands for. Always 1 except at the
   *  `far` LOD level, where `bundleByModule` folds a module's functions into
   *  one module node and reports the count honestly (spec 25 §5b). */
  readonly members: number;
}

export interface GraphEdgeModel {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** A dashed `who-calls-by-name` candidate edge, not a resolved edge. */
  readonly byName: boolean;
  /** How many source edges this edge stands for: 1 everywhere except a
   *  `far`-level bundle, where parallel module-to-module edges merge. */
  readonly weight: number;
}

export interface GraphModel {
  readonly nodes: readonly GraphNodeModel[];
  readonly edges: readonly GraphEdgeModel[];
  readonly shown: number;
  /** Nodes the cap dropped. `> 0` is what raises the truncation bar. */
  readonly hidden: number;
  readonly total: number;
}

export const EMPTY_MODEL: GraphModel = { nodes: [], edges: [], shown: 0, hidden: 0, total: 0 };

/** One fetched hop: the callers/callees/by-name candidates of ONE function.
 *  The focus contributes one; every expanded node contributes another. */
export interface CallHop {
  readonly fn: number;
  readonly callers: readonly XrefEdge[];
  readonly callees: readonly XrefEdge[];
  readonly byName: readonly ByNameCaller[];
}

export interface CallModelInput {
  readonly focus: number;
  readonly focusLabel: string;
  readonly focusSize: number | null;
  readonly focusModule: number | null;
  readonly hops: readonly CallHop[];
  readonly expanded: ReadonlySet<number>;
  /** Finding severity for a function, when one names it. */
  readonly severityOf?: (fn: number) => Severity | null;
}

function edgeId(source: string, target: string, byName: boolean): string {
  return `${byName ? "n" : "e"}:${source}->${target}`;
}

/** Builder shared by both modes: insertion-ordered nodes, cap applied on
 *  insert, edges dropped when either end was capped away. */
class Builder {
  private readonly nodes = new Map<string, GraphNodeModel>();
  private readonly edges = new Map<string, GraphEdgeModel>();
  private dropped = 0;

  add(input: Omit<GraphNodeModel, "members"> & { readonly members?: number }): boolean {
    const node: GraphNodeModel = { ...input, members: input.members ?? 1 };
    const existing = this.nodes.get(node.id);
    if (existing !== undefined) {
      // A node first seen as a by-name candidate and later as a real
      // neighbour is a real neighbour: the weaker claim never wins.
      if (existing.byName && !node.byName) this.nodes.set(node.id, { ...existing, byName: false });
      return true;
    }
    if (this.nodes.size >= GRAPH_NODE_CAP) {
      this.dropped += 1;
      return false;
    }
    this.nodes.set(node.id, node);
    return true;
  }

  link(source: string, target: string, byName: boolean): void {
    if (!this.nodes.has(source) || !this.nodes.has(target)) return;
    const id = edgeId(source, target, byName);
    if (!this.edges.has(id)) this.edges.set(id, { id, source, target, byName, weight: 1 });
  }

  build(): GraphModel {
    const nodes = [...this.nodes.values()];
    return {
      nodes,
      edges: [...this.edges.values()],
      shown: nodes.length,
      hidden: this.dropped,
      total: nodes.length + this.dropped,
    };
  }
}

function refNodeId(fn: number | string, name: string | null): string {
  return typeof fn === "number" ? `fn:${fn}` : `ext:${name ?? String(fn)}`;
}

function labelFor(fn: number | string, name: string | null): string {
  if (name !== null && name.length > 0) return name;
  return typeof fn === "number" ? `fn:${fn}` : String(fn);
}

/** Spec 25 §3 mode 1 — a function's call neighbourhood. */
export function buildCallModel(input: CallModelInput): GraphModel {
  const b = new Builder();
  const sev = input.severityOf ?? (() => null);
  b.add({
    id: `fn:${input.focus}`,
    kind: "fn",
    ref: input.focus,
    label: input.focusLabel,
    size: input.focusSize,
    module: input.focusModule,
    severity: sev(input.focus),
    isFocus: true,
    byName: false,
    expanded: true,
  });
  const neighbour = (fn: number | string, name: string | null, size: number | null, module: number | null, byName: boolean): string | null => {
    const id = refNodeId(fn, name);
    const ref = typeof fn === "number" ? fn : -1;
    const ok = b.add({
      id,
      kind: "fn",
      ref,
      label: labelFor(fn, name),
      size,
      module,
      severity: ref >= 0 ? sev(ref) : null,
      isFocus: false,
      byName,
      expanded: ref >= 0 && input.expanded.has(ref),
    });
    return ok ? id : null;
  };
  for (const hop of input.hops) {
    const hopId = `fn:${hop.fn}`;
    if (!b.add({
      id: hopId,
      kind: "fn",
      ref: hop.fn,
      label: `fn:${hop.fn}`,
      size: null,
      module: null,
      severity: sev(hop.fn),
      isFocus: hop.fn === input.focus,
      byName: false,
      expanded: true,
    })) continue;
    for (const e of hop.callers) {
      const id = neighbour(e.fn, e.name, e.size, e.module ?? null, false);
      if (id !== null) b.link(id, hopId, false);
    }
    for (const e of hop.callees) {
      const id = neighbour(e.fn, e.name, e.size, e.module ?? null, false);
      if (id !== null) b.link(hopId, id, false);
    }
    for (const c of hop.byName) {
      const id = neighbour(c.fn, c.callerName, c.size, null, true);
      if (id !== null) b.link(id, hopId, true);
    }
  }
  return b.build();
}

/** The result of `neighbourSet`: which nodes and edges should read as
 *  "highlighted" — everything else in the pane dims (bur 8). */
export interface NeighbourSet {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

/** `id` plus every node one edge away from it, and the ids of those edges.
 *  Pure and cheap (linear scan of the already-capped edge list) — used for
 *  BOTH hover/selection highlight (bur 8) and the follow-toggle's call-site
 *  highlight (bur 10), which is the same "light up a neighbourhood" idea. */
export function neighbourSet(model: GraphModel, id: string): NeighbourSet {
  const nodes = new Set<string>([id]);
  const edges = new Set<string>();
  for (const e of model.edges) {
    if (e.source !== id && e.target !== id) continue;
    edges.add(e.id);
    nodes.add(e.source);
    nodes.add(e.target);
  }
  return { nodes, edges };
}

/** Bur 10: does the listing `selection` point at one of the graph's already
 *  drawn neighbours? True only for an identifier selected INSIDE the
 *  graph's own focus function (a call site's callee, spec 25 §3) whose text
 *  matches a drawn neighbour's label — never the focus itself, never a
 *  selection in an unrelated function. Returns that neighbour's node id, or
 *  `null` when nothing in the drawn neighbourhood matches. */
export function calleeNodeForSelection(
  model: GraphModel,
  selection: { readonly kind: string; readonly fn?: number; readonly name?: string },
): string | null {
  if (selection.kind !== "identifier" || selection.name === undefined) return null;
  const focus = model.nodes.find((n) => n.isFocus);
  if (focus === undefined || focus.kind !== "fn" || focus.ref !== selection.fn) return null;
  const hit = model.nodes.find((n) => !n.isFocus && n.label === selection.name);
  return hit?.id ?? null;
}

export interface ModuleModelInput {
  readonly focus: number;
  readonly deps: readonly number[];
  readonly dependents: readonly number[];
  readonly focusLabel?: string | null;
  readonly labelOf?: (mod: number) => string | null;
}

/** Spec 25 §3 mode 2 — one module's DIRECT edges (spec 17 §14 cut the whole
 *  module graph; this never walks past one hop). */
export function buildModuleModel(input: ModuleModelInput): GraphModel {
  const b = new Builder();
  const label = (mod: number): string => input.labelOf?.(mod) ?? `module ${mod}`;
  const node = (mod: number, isFocus: boolean): string | null => {
    const id = `mod:${mod}`;
    const ok = b.add({
      id,
      kind: "module",
      ref: mod,
      label: isFocus ? input.focusLabel ?? label(mod) : label(mod),
      size: null,
      module: mod,
      severity: null,
      isFocus,
      byName: false,
      expanded: isFocus,
    });
    return ok ? id : null;
  };
  const focusId = node(input.focus, true);
  if (focusId === null) return b.build();
  for (const m of input.dependents) {
    const id = node(m, false);
    if (id !== null) b.link(id, focusId, false);
  }
  for (const m of input.deps) {
    const id = node(m, false);
    if (id !== null) b.link(focusId, id, false);
  }
  return b.build();
}

// -- Semantic zoom / level of detail (spec 25 §5b, bur 9) -------------------
//
// Fred's ask: "it should have a level of recursion view ... kind of like a
// fractal: as you zoom in you see more". Three levels, all derived from data
// the pane has ALREADY fetched - a level change never walks the bundle:
//
//   far  - modules as nodes, function-to-function edges bundled into
//          module-to-module edges with a weight (`bundleByModule`).
//   mid  - the function neighbourhood the pane has always drawn.
//   near - the focus function opened up. Until spec 26 L9 ships
//          `GET /api/fn/{fn}/cfg` this is the focus's own card with its
//          callers/callees listed inside it (`lodCard`); L9 swaps that card
//          body for the block graph and nothing else here moves.

export type LodLevel = "far" | "mid" | "near";

/** Coarse-to-fine, the order `graph.lodCycle` steps through. */
export const LOD_LEVELS: readonly LodLevel[] = ["far", "mid", "near"];

/** Viewport-zoom boundaries between the levels. */
export const LOD_THRESHOLDS = { farMid: 0.5, midNear: 1.6 } as const;

/** Half-width of the sticky band around each threshold, as a FRACTION of
 *  the threshold: a level flips up only past `t * (1 + h)` and back down
 *  only below `t * (1 - h)`, so a viewport hovering on a boundary keeps the
 *  level it already had instead of flickering between two layouts. */
export const LOD_HYSTERESIS = 0.12;

/** The zoom a level is "at home" at - used when the level is set directly
 *  (the toolbar control, `graph.lodCycle`, "reset view"), so that the next
 *  `lodLevel()` derived from the viewport agrees with what was set. */
export const LOD_NOMINAL_ZOOM: Readonly<Record<LodLevel, number>> = { far: 0.35, mid: 0.9, near: 2 };

function stickyAbove(zoom: number, threshold: number, wasAbove: boolean): boolean {
  if (zoom >= threshold * (1 + LOD_HYSTERESIS)) return true;
  if (zoom < threshold * (1 - LOD_HYSTERESIS)) return false;
  return wasAbove;
}

/** The LOD level a React Flow viewport zoom implies, given the level the
 *  view is already at. Pure, total, and hysteretic: `lodLevel(z, prev)`
 *  inside a boundary band returns `prev`. */
export function lodLevel(zoom: number, prev: LodLevel = "mid"): LodLevel {
  if (!Number.isFinite(zoom)) return prev;
  if (!stickyAbove(zoom, LOD_THRESHOLDS.farMid, prev !== "far")) return "far";
  return stickyAbove(zoom, LOD_THRESHOLDS.midNear, prev === "near") ? "near" : "mid";
}

/** far -> mid -> near -> far, for the toolbar control and `graph.lodCycle`. */
export function nextLodLevel(level: LodLevel): LodLevel {
  const i = LOD_LEVELS.indexOf(level);
  return LOD_LEVELS[(i + 1) % LOD_LEVELS.length] ?? "mid";
}

/** Which bundle a node belongs to at the `far` level: its module when it has
 *  one, itself when it has not. A function whose module the contract did not
 *  report is NOT guessed into somebody's module - it stays its own node. */
function bundleIdOf(n: GraphNodeModel): string {
  if (n.kind === "module") return n.id;
  return n.module !== null ? `mod:${n.module}` : n.id;
}

const SEVERITY_ORDER: readonly Severity[] = ["low", "med", "high", "critical"];

function worseSeverity(a: Severity | null, b: Severity | null): Severity | null {
  if (a === null) return b;
  if (b === null) return a;
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

/** Spec 25 §5b `far`: fold every function node into its module and bundle
 *  the edges between two modules into ONE edge carrying the count. Pure and
 *  derived - no fetch, no new route, and `hidden` (the cap's honest count)
 *  carries through untouched. Intra-module edges become self-loops and are
 *  dropped: they are exactly what the `mid` level draws. */
export function bundleByModule(model: GraphModel): GraphModel {
  const nodes = new Map<string, GraphNodeModel>();
  for (const n of model.nodes) {
    const id = bundleIdOf(n);
    const prev = nodes.get(id);
    if (prev === undefined) {
      nodes.set(id, id === n.id
        ? { ...n, members: n.members }
        : {
            id,
            kind: "module",
            ref: n.module ?? -1,
            label: `module ${n.module}`,
            size: n.size,
            module: n.module,
            severity: n.severity,
            isFocus: n.isFocus,
            byName: n.byName,
            expanded: true,
            members: n.members,
          });
      continue;
    }
    nodes.set(id, {
      ...prev,
      size: prev.size === null && n.size === null ? null : (prev.size ?? 0) + (n.size ?? 0),
      severity: worseSeverity(prev.severity, n.severity),
      isFocus: prev.isFocus || n.isFocus,
      byName: prev.byName && n.byName,
      members: prev.members + n.members,
    });
  }
  const bundleOf = new Map<string, string>(model.nodes.map((n) => [n.id, bundleIdOf(n)]));
  const edges = new Map<string, GraphEdgeModel>();
  for (const e of model.edges) {
    const source = bundleOf.get(e.source) ?? e.source;
    const target = bundleOf.get(e.target) ?? e.target;
    if (source === target) continue;
    const id = `b:${source}->${target}`;
    const prev = edges.get(id);
    edges.set(id, prev === undefined
      ? { id, source, target, byName: e.byName, weight: e.weight }
      : { ...prev, byName: prev.byName && e.byName, weight: prev.weight + e.weight });
  }
  const list = [...nodes.values()];
  return { nodes: list, edges: [...edges.values()], shown: list.length, hidden: model.hidden, total: list.length + model.hidden };
}

/** How many callers/callees the `near` card lists before it says "+N more".
 *  The card is bounded on purpose: the near level opens ONE node up, it
 *  never pulls the rest of the bundle in behind it. */
export const LOD_CARD_CAP = 8;

export interface LodCard {
  readonly callers: readonly string[];
  readonly callees: readonly string[];
  readonly moreCallers: number;
  readonly moreCallees: number;
}

/** Spec 25 §5b `near`, degraded form: what the focus node's card shows until
 *  spec 26 L9's CFG route exists - its already-drawn callers and callees, by
 *  label, capped at `cap`. Reads only the model, so it can never disagree
 *  with the edges on screen. */
export function lodCard(model: GraphModel, id: string, cap: number = LOD_CARD_CAP): LodCard {
  const labelOf = new Map(model.nodes.map((n) => [n.id, n.label]));
  const callers: string[] = [];
  const callees: string[] = [];
  for (const e of model.edges) {
    if (e.target === id && e.source !== id) callers.push(labelOf.get(e.source) ?? e.source);
    else if (e.source === id && e.target !== id) callees.push(labelOf.get(e.target) ?? e.target);
  }
  return {
    callers: callers.slice(0, cap),
    callees: callees.slice(0, cap),
    moreCallers: Math.max(0, callers.length - cap),
    moreCallees: Math.max(0, callees.length - cap),
  };
}

/** The model actually drawn at `level`. `mid`/`near` draw the fetched
 *  neighbourhood (near only changes how the FOCUS node renders); `far`
 *  bundles it by module. One pure entry point, so the pane and the tests
 *  agree by construction. */
export function modelForLevel(model: GraphModel, level: LodLevel): GraphModel {
  return level === "far" ? bundleByModule(model) : model;
}
