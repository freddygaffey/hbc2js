// ui/src/graph/store.ts — what the graph pane is currently looking at
// (spec 25 §3/§4). Same module-level `useSyncExternalStore` pattern as
// ui/src/state/selection.ts and ui/src/actions/store.ts, and for the same
// reason: the actions (`graph.open`/`graph.expand`/`graph.focus`) run
// outside React and must be able to set it.
import { useSyncExternalStore } from "react";
import { select, type Selection } from "../state/selection.ts";
import { lodLevel as lodLevelFor, nextLodLevel, type GraphKind, type LodLevel } from "./model.ts";
import type { Point } from "./layout.ts";

export interface GraphTarget {
  readonly kind: GraphKind;
  readonly ref: number;
}

export interface GraphViewState {
  /** `null` = nothing to draw (no fn/module selection yet). */
  readonly target: GraphTarget | null;
  /** Breadcrumb, oldest first; `target` is its last entry when non-empty. */
  readonly trail: readonly GraphTarget[];
  /** Functions expanded one extra hop beyond the focus (call mode only). */
  readonly expanded: readonly number[];
  /** The selection the current target was derived from — how the pane knows
   *  a selection change is new and should re-root the graph, while an
   *  in-graph focus change (which does not touch the selection) must not. */
  readonly origin: string | null;
  readonly maximised: boolean;
  /** Bur 8: manual drag positions, absolute flow-space, keyed by node id —
   *  overlaid on top of the pure dagre layout (`layoutModel`) until "Reset
   *  view" clears them. Cleared whenever the drawn neighbourhood itself
   *  changes (`rootGraph`/`focusGraphNode`/`graphBack`), since a stale
   *  offset for a node that is no longer even drawn is meaningless. */
  readonly dragPositions: ReadonlyMap<string, Point>;
  /** The node currently hovered, for bur 8's highlight. Also doubles as an
   *  explicit override of the follow-derived highlight (bur 10) — hovering
   *  something always wins over "what the listing selected". */
  readonly hoverNode: string | null;
  /** Bur 10: track the listing selection (re-focus + call-site highlight).
   *  Persisted; default ON (see `readFollow`). */
  readonly follow: boolean;
  /** Bur 9 / spec 25 §5b: the semantic-zoom level the canvas is drawn at.
   *  Derived from the viewport zoom on a USER gesture (`lodLevel`), or set
   *  outright by the toolbar control / `graph.lodCycle` / "reset view". */
  readonly lod: LodLevel;
  /** The level the CURRENT neighbourhood was rooted at - what "reset view"
   *  returns to (spec 25 §5a/§5b). */
  readonly rootLod: LodLevel;
  /** Expansions parked while the view is at `far` (where a module bundle
   *  makes a per-function hop meaningless), restored on the way back to
   *  `mid`. Bounded by `LOD_EXPAND_CAP`: a level change never re-expands
   *  more than a handful of hops, and never loads the whole bundle. */
  readonly lodStashed: readonly number[];
}

/** The most expansions a single level change will ever restore (spec 25
 *  §5b: bounded expansion, never the whole bundle). */
export const LOD_EXPAND_CAP = 8;

const FOLLOW_KEY = "hbc2js.graph.follow";

/** Same try/catch idiom as ui/src/activity/store.ts: a private-browsing tab
 *  (or anything else `Storage` can throw for) degrades to in-memory only. */
function readFollow(): boolean {
  try {
    const v = window.localStorage.getItem(FOLLOW_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeFollow(value: boolean): void {
  try {
    window.localStorage.setItem(FOLLOW_KEY, value ? "1" : "0");
  } catch {
    // ignore — best-effort persistence only.
  }
}

const NO_DRAG: ReadonlyMap<string, Point> = new Map();

const EMPTY: GraphViewState = {
  target: null, trail: [], expanded: [], origin: null, maximised: false,
  dragPositions: NO_DRAG, hoverNode: null, follow: readFollow(),
  lod: "mid", rootLod: "mid", lodStashed: [],
};

let state: GraphViewState = EMPTY;
const listeners = new Set<() => void>();

function set(patch: Partial<GraphViewState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getGraphState(): GraphViewState {
  return state;
}

export function useGraphState(): GraphViewState {
  return useSyncExternalStore(subscribe, getGraphState, getGraphState);
}

/** The graph target a selection implies: an explicit module selection, else
 *  the function the selection carries. `null` when it implies neither. */
export function targetForSelection(sel: Selection): GraphTarget | null {
  if (sel.kind === "module" && sel.moduleId !== undefined) {
    const ref = Number(sel.moduleId);
    return Number.isFinite(ref) ? { kind: "module", ref } : null;
  }
  if (sel.fn !== undefined && sel.fn >= 0) return { kind: "fn", ref: sel.fn };
  return null;
}

export function originKey(t: GraphTarget | null): string | null {
  return t === null ? null : `${t.kind}:${t.ref}`;
}

/** The listing selection a graph target implies — the inverse of
 *  `targetForSelection`. Pure (no store access), so bur 14's Playwright
 *  fixture and a plain vitest both cover it without mounting React Flow. */
export function selectionForGraphTarget(target: GraphTarget): Selection {
  return target.kind === "module" ? { kind: "module", moduleId: String(target.ref) } : { kind: "fn", fn: target.ref };
}

/** Bur 14 (docs/UI-BURS.md #14): double-click on a graph node must actually
 *  land the analyst on the code, not just push a selection nothing shows.
 *  Two parts: (1) select the node's fn/module, which the listing already
 *  knows how to scroll to and highlight (`../panes/CenterPane.tsx`); (2) if
 *  the graph pane is maximised it sits `fixed inset-0 z-50` over the WHOLE
 *  window (see GraphPane.tsx), hiding the listing behind it even though the
 *  selection changed underneath — so un-maximise to reveal it. */
export function openGraphTargetInListing(target: GraphTarget): void {
  select(selectionForGraphTarget(target));
  if (state.maximised) setGraphMaximised(false);
}

/** Re-root the graph on `target`, forgetting the trail and every expansion.
 *  `origin` records the selection this came from (see `GraphViewState`). */
export function rootGraph(target: GraphTarget | null, origin: string | null): void {
  if (target === null) {
    set({ target: null, trail: [], expanded: [], origin, dragPositions: NO_DRAG, rootLod: state.lod, lodStashed: [] });
    return;
  }
  set({ target, trail: [target], expanded: [], origin, dragPositions: NO_DRAG, rootLod: state.lod, lodStashed: [] });
}

/** Focus a node already on screen: the graph re-centres on it and the
 *  breadcrumb grows. Deliberately does NOT touch the selection store — that
 *  is what double-click does (spec 25 §3). */
export function focusGraphNode(target: GraphTarget): void {
  if (state.target !== null && state.target.kind === target.kind && state.target.ref === target.ref) return;
  set({ target, trail: [...state.trail, target], expanded: [], dragPositions: NO_DRAG, rootLod: state.lod, lodStashed: [] });
}

/** Step back along the breadcrumb. */
export function graphBack(): void {
  if (state.trail.length < 2) return;
  const trail = state.trail.slice(0, -1);
  set({ trail, target: trail[trail.length - 1]!, expanded: [], dragPositions: NO_DRAG, rootLod: state.lod, lodStashed: [] });
}

/** Expand `fn` one hop (idempotent); `graph.expand` with no argument expands
 *  the current focus, which is a no-op since the focus is always expanded. */
export function expandGraphNode(fn: number): void {
  if (state.expanded.includes(fn)) return;
  set({ expanded: [...state.expanded, fn] });
}

export function collapseGraphNode(fn: number): void {
  if (!state.expanded.includes(fn)) return;
  set({ expanded: state.expanded.filter((f) => f !== fn) });
}

export function setGraphMaximised(maximised: boolean): void {
  set({ maximised });
}

/** Bur 8: record a node's manually dragged position (called from
 *  `onNodesChange`'s `position` changes — including the fast-firing
 *  mid-drag ones, so the drag reads as live movement, not just a drop). */
export function setNodePosition(id: string, pos: Point): void {
  const next = new Map(state.dragPositions);
  next.set(id, pos);
  set({ dragPositions: next });
}

/** Bur 8's "Reset view" button: drop every manual drag offset, so the pane
 *  falls back onto the pure dagre layout. The caller also re-runs
 *  `fitView` — that is a React Flow instance method, not state, so it lives
 *  in GraphPane, not here. */
export function resetGraphView(): void {
  setGraphLod(state.rootLod);
  set({ dragPositions: NO_DRAG });
}

export function setHoverNode(id: string | null): void {
  if (state.hoverNode === id) return;
  set({ hoverNode: id });
}

/** Bur 10's toolbar toggle. Persisted across reloads. */
export function setGraphFollow(follow: boolean): void {
  writeFollow(follow);
  set({ follow });
}

/** Test/dev only. */
export function resetGraphState(): void {
  state = { ...EMPTY, follow: readFollow() };
  for (const l of [...listeners]) l();
}

// -- Bur 9 / spec 25 §5b: semantic zoom ------------------------------------

/** Move the canvas to `level`, doing the bounded expand/collapse bookkeeping
 *  the level change implies. Going to `far` COLLAPSES every extra hop (the
 *  module bundle does not draw them anyway) after parking at most
 *  `LOD_EXPAND_CAP` of them; coming back from `far` re-expands exactly those,
 *  through the same `expandGraphNode`/`collapseGraphNode` the "+" button
 *  uses - so a level change can never fetch more than the analyst had
 *  already asked for. */
export function setGraphLod(level: LodLevel): void {
  if (state.lod === level) return;
  const leavingFar = state.lod === "far";
  const stash = level === "far" ? state.expanded.slice(0, LOD_EXPAND_CAP) : [];
  if (level === "far") {
    for (const fn of [...state.expanded]) collapseGraphNode(fn);
    set({ lod: level, lodStashed: stash });
    return;
  }
  if (leavingFar && state.lodStashed.length > 0) {
    const restore = state.lodStashed.slice(0, LOD_EXPAND_CAP);
    set({ lod: level, lodStashed: [] });
    for (const fn of restore) expandGraphNode(fn);
    return;
  }
  set({ lod: level });
}

/** `graph.lodCycle` (chord `g z`): far -> mid -> near -> far. */
export function cycleGraphLod(): LodLevel {
  const next = nextLodLevel(state.lod);
  setGraphLod(next);
  return next;
}

/** A USER zoom gesture reported by React Flow's `onMove`. Programmatic
 *  viewport moves (`fitView`, the Controls +/- buttons) deliberately do NOT
 *  come through here: the pane fitting itself must never change the level
 *  under the analyst (spec 25 §5b). Hysteresis lives in `lodLevel`. */
export function setGraphLodFromZoom(zoom: number): void {
  setGraphLod(lodLevelFor(zoom, state.lod));
}
