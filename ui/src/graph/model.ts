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
}

export interface GraphEdgeModel {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** A dashed `who-calls-by-name` candidate edge, not a resolved edge. */
  readonly byName: boolean;
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

  add(node: GraphNodeModel): boolean {
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
    if (!this.edges.has(id)) this.edges.set(id, { id, source, target, byName });
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
