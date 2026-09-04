// ui/src/graph/store.ts — what the graph pane is currently looking at
// (spec 25 §3/§4). Same module-level `useSyncExternalStore` pattern as
// ui/src/state/selection.ts and ui/src/actions/store.ts, and for the same
// reason: the actions (`graph.open`/`graph.expand`/`graph.focus`) run
// outside React and must be able to set it.
import { useSyncExternalStore } from "react";
import type { Selection } from "../state/selection.ts";
import type { GraphKind } from "./model.ts";

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
}

const EMPTY: GraphViewState = { target: null, trail: [], expanded: [], origin: null, maximised: false };

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

/** Re-root the graph on `target`, forgetting the trail and every expansion.
 *  `origin` records the selection this came from (see `GraphViewState`). */
export function rootGraph(target: GraphTarget | null, origin: string | null): void {
  if (target === null) {
    set({ target: null, trail: [], expanded: [], origin });
    return;
  }
  set({ target, trail: [target], expanded: [], origin });
}

/** Focus a node already on screen: the graph re-centres on it and the
 *  breadcrumb grows. Deliberately does NOT touch the selection store — that
 *  is what double-click does (spec 25 §3). */
export function focusGraphNode(target: GraphTarget): void {
  if (state.target !== null && state.target.kind === target.kind && state.target.ref === target.ref) return;
  set({ target, trail: [...state.trail, target], expanded: [] });
}

/** Step back along the breadcrumb. */
export function graphBack(): void {
  if (state.trail.length < 2) return;
  const trail = state.trail.slice(0, -1);
  set({ trail, target: trail[trail.length - 1]!, expanded: [] });
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

/** Test/dev only. */
export function resetGraphState(): void {
  state = EMPTY;
  for (const l of [...listeners]) l();
}
