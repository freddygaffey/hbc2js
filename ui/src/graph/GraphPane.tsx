// ui/src/graph/GraphPane.tsx — spec 25's Graph tab: the neighbourhood of
// whatever is selected, drawn with React Flow + dagre (D28) over the SAME
// routes the Xrefs pane uses (`/api/fn/{fn}/callers`, `/callees`,
// `/api/xref/who-calls-by-name`, `/api/module/{id}`). Never the whole graph:
// one hop from the focus, and one more per node the analyst expands.
import { ReactFlow, Background, Controls, MarkerType, type Edge } from "@xyflow/react";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./graph.css";
import { api } from "../api.ts";
import type { CallsFrom, Severity, WhoCalls, WhoCallsByName } from "../contracts.ts";
import { useFindings, useFn, useModule } from "../hooks.ts";
import { displayName } from "../listing/names.ts";
import { select, useSelection } from "../state/selection.ts";
import { buildCallModel, buildModuleModel, EMPTY_MODEL, GRAPH_NODE_CAP, type CallHop, type GraphModel } from "./model.ts";
import { layoutModel } from "./layout.ts";
import { nodeTypes, type HbcFlowNode } from "./nodes.tsx";
import {
  expandGraphNode, focusGraphNode, graphBack, originKey, rootGraph, setGraphMaximised, targetForSelection, useGraphState,
} from "./store.ts";

/** Same idiom and wording shape as the listing's truncation bar
 *  (ui/src/panes/CenterPane.tsx): say exactly how many are not drawn. */
function GraphTruncationBar({ shown, hidden }: { readonly shown: number; readonly hidden: number }): ReactNode {
  return (
    <div data-graph-truncated={hidden} className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3 text-xs text-text-muted">
      <span className="text-text">truncated</span>
      <span>
        drawing {shown.toLocaleString()} nodes, {hidden.toLocaleString()} more not drawn (graph cap {GRAPH_NODE_CAP})
      </span>
    </div>
  );
}

/** Findings that name a function, as `fn -> severity` (worst wins). */
function useSeverityByFn(): (fn: number) => Severity | null {
  const findings = useFindings();
  return useMemo(() => {
    const order: readonly Severity[] = ["low", "med", "high", "critical"];
    const map = new Map<number, Severity>();
    for (const f of findings.data?.rows ?? []) {
      const m = /^fn:(\d+)/.exec(f.record.target);
      if (m === null) continue;
      const fn = Number(m[1]);
      const prev = map.get(fn);
      if (prev === undefined || order.indexOf(f.record.severity) > order.indexOf(prev)) map.set(fn, f.record.severity);
    }
    return (fn: number) => map.get(fn) ?? null;
  }, [findings.data]);
}

/** One `CallHop` per fetched function, over the SAME query keys `hooks.ts`
 *  uses — so the Xrefs pane and the graph share one cache entry, and a
 *  rename's `invalidateFn` refreshes both. */
function useCallHops(fns: readonly number[], enabled: boolean): readonly CallHop[] {
  const callers = useQueries({
    queries: fns.map((fn) => ({ queryKey: ["who-calls", fn], queryFn: () => api.whoCalls(fn), enabled })),
  }) as readonly { data?: WhoCalls }[];
  const callees = useQueries({
    queries: fns.map((fn) => ({ queryKey: ["calls-from", fn], queryFn: () => api.callsFrom(fn), enabled })),
  }) as readonly { data?: CallsFrom }[];
  const byName = useQueries({
    queries: fns.map((fn) => ({ queryKey: ["who-calls-by-name", fn], queryFn: () => api.xrefWhoCallsByName(fn), enabled })),
  }) as readonly { data?: WhoCallsByName }[];
  const callerRows = callers.map((r) => r.data?.rows).join(",");
  const calleeRows = callees.map((r) => r.data?.rows).join(",");
  const byNameRows = byName.map((r) => r.data?.rows).join(",");
  return useMemo(
    () =>
      fns.map((fn, i) => ({
        fn,
        callers: callers[i]?.data?.rows ?? [],
        callees: callees[i]?.data?.rows ?? [],
        byName: byName[i]?.data?.rows ?? [],
      })),
    // The joined row identities stand in for the result arrays, which
    // `useQueries` re-creates on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fns, callerRows, calleeRows, byNameRows],
  );
}

export function GraphPane({ visible }: { readonly visible: boolean }): ReactNode {
  const sel = useSelection();
  const gs = useGraphState();

  // Follow the selection: a NEW selection re-roots the graph, but an
  // in-graph focus change (which never touches the selection store) does
  // not (spec 25 §3).
  useEffect(() => {
    if (!visible) return;
    const t = targetForSelection(sel);
    const key = originKey(t);
    if (key !== gs.origin) rootGraph(t, key);
  }, [visible, sel, gs.origin]);

  const target = gs.target;
  const callMode = target?.kind === "fn";
  const focusFn = callMode ? target.ref : -1;
  const meta = useFn(visible && callMode ? focusFn : -1);
  const mod = useModule(visible && target?.kind === "module" ? target.ref : -1);
  const severityOf = useSeverityByFn();

  const hopFns = useMemo(
    () => (callMode ? [focusFn, ...gs.expanded.filter((f) => f !== focusFn)] : []),
    [callMode, focusFn, gs.expanded],
  );
  const hops = useCallHops(hopFns, visible && callMode);
  const expanded = useMemo(() => new Set(gs.expanded), [gs.expanded]);

  const model: GraphModel = useMemo(() => {
    if (target === null) return EMPTY_MODEL;
    if (target.kind === "module") {
      return buildModuleModel({
        focus: target.ref,
        deps: mod.data?.deps ?? [],
        dependents: mod.data?.dependents ?? [],
        focusLabel: mod.data?.file ?? null,
      });
    }
    return buildCallModel({
      focus: target.ref,
      focusLabel: displayName(target.ref, meta.data),
      focusSize: null,
      focusModule: meta.data?.module ?? null,
      hops,
      expanded,
      severityOf,
    });
  }, [target, mod.data, meta.data, hops, expanded, severityOf]);

  const positions = useMemo(() => layoutModel(model), [model]);

  const flowNodes: HbcFlowNode[] = useMemo(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: "hbc" as const,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { model: n, onExpand: expandGraphNode },
      })),
    [model, positions],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      model.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        style: e.byName
          ? { stroke: "var(--text-muted)", strokeDasharray: "4 3" }
          : { stroke: "var(--border)" },
        markerEnd: { type: MarkerType.ArrowClosed, color: e.byName ? "var(--text-muted)" : "var(--border)" },
      })),
    [model],
  );

  const body = (
    <div className="flex min-h-0 flex-1 flex-col" data-graph-nodes={model.shown}>
      {target === null ? (
        <div className="p-3 text-xs text-text-muted">select a function or a module to graph its neighbourhood</div>
      ) : (
        <div className="min-h-0 flex-1">
          <ReactFlow
            key={`${target.kind}:${target.ref}`}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
            minZoom={0.15}
            nodesConnectable={false}
            edgesFocusable={false}
            onNodeClick={(_e, node) => {
              const m = node.data.model;
              if (m.ref >= 0 && !m.isFocus) focusGraphNode({ kind: m.kind, ref: m.ref });
            }}
            onNodeDoubleClick={(_e, node) => {
              const m = node.data.model;
              if (m.ref < 0) return;
              if (m.kind === "module") select({ kind: "module", moduleId: String(m.ref) });
              else select({ kind: "fn", fn: m.ref });
            }}
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      {model.hidden > 0 ? <GraphTruncationBar shown={model.shown} hidden={model.hidden} /> : null}
    </div>
  );

  const header = (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2 text-xs text-text-muted">
      <button
        type="button"
        disabled={gs.trail.length < 2}
        onClick={() => graphBack()}
        className="rounded-ui px-1 hover:bg-surface-2 disabled:opacity-40"
        title="back along the graph breadcrumb"
      >
        ←
      </button>
      <span data-graph-trail={gs.trail.length} className="truncate font-mono">
        {gs.trail.map((t) => `${t.kind === "fn" ? "fn" : "mod"}:${t.ref}`).join(" › ") || "—"}
      </span>
      <span className="ml-auto shrink-0">{model.shown} nodes</span>
      <button
        type="button"
        data-graph-maximise
        onClick={() => setGraphMaximised(!gs.maximised)}
        className="shrink-0 rounded-ui px-1 hover:bg-surface-2"
        title={gs.maximised ? "restore the graph into the side panel" : "maximise the graph over the window"}
      >
        {gs.maximised ? "▣" : "⛶"}
      </button>
    </div>
  );

  return (
    <div
      data-graph-pane
      data-graph-maximised={gs.maximised ? "true" : "false"}
      className={gs.maximised ? "fixed inset-0 z-50 flex flex-col bg-bg" : "flex h-full min-h-0 flex-col"}
    >
      {header}
      {body}
    </div>
  );
}
