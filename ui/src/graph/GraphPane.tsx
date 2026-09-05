// ui/src/graph/GraphPane.tsx — spec 25's Graph tab: the neighbourhood of
// whatever is selected, drawn with React Flow + dagre (D28) over the SAME
// routes the Xrefs pane uses (`/api/fn/{fn}/callers`, `/callees`,
// `/api/xref/who-calls-by-name`, `/api/module/{id}`). Never the whole graph:
// one hop from the focus, and one more per node the analyst expands.
import { ReactFlow, Background, Controls, MarkerType, type Edge, type ReactFlowInstance } from "@xyflow/react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "@xyflow/react/dist/style.css";
import "./graph.css";
import { api } from "../api.ts";
import type { CallsFrom, Severity, WhoCalls, WhoCallsByName } from "../contracts.ts";
import { useFindings, useFn, useModule } from "../hooks.ts";
import { displayName } from "../listing/names.ts";
import { useSelection } from "../state/selection.ts";
import {
  buildCallModel, buildCfgModel, buildModuleModel, calleeNodeForSelection, EMPTY_MODEL, GRAPH_NODE_CAP, lodCard,
  LOD_NOMINAL_ZOOM, modelForLevel, neighbourSet,
  type CallHop, type GraphModel, type NeighbourSet,
} from "./model.ts";
import { layoutGraph, NODE_H_NEAR, type Size } from "./layout.ts";
import { nodeTypes, type HbcFlowNode } from "./nodes.tsx";
import {
  cycleGraphLod, expandGraphNode, focusGraphNode, graphBack, openGraphTargetInListing, originKey, resetGraphView,
  rootGraph, setGraphFollow, setGraphLodFromZoom, setGraphMaximised, setHoverNode, setNodePosition, targetForSelection,
  useGraphState,
} from "./store.ts";

/** How much slack `fitView` leaves around the neighbourhood. Small, because
 *  bur 11's layout already sizes the graph for the frame - a large padding
 *  would spend the legibility the wrapped grid just bought back. */
const FIT_PADDING = 0.08;

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
  const rfInstance = useRef<ReactFlowInstance<HbcFlowNode, Edge> | null>(null);

  // Follow the selection: a NEW selection re-roots the graph, but an
  // in-graph focus change (which never touches the selection store) does
  // not (spec 25 §3). Bur 10: this whole effect is the "follow" behaviour —
  // gated on the toggle, so turning it off freezes the graph where it is,
  // and turning it back on catches up on the next selection change.
  useEffect(() => {
    if (!visible || !gs.follow) return;
    const t = targetForSelection(sel);
    const key = originKey(t);
    if (key !== gs.origin) rootGraph(t, key);
  }, [visible, sel, gs.origin, gs.follow]);

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

  // Spec 26 L9 / spec 25 §3 mode 3: the `near` level draws the focus
  // function's OWN block graph. Fetched only at that level (zooming in is
  // the gesture that asks for it; `mid`/`far` never pay for it), never
  // retried - a 404 here is the route DECLINING the function, a stable
  // answer, and the pane degrades to §5b's card instead.
  const cfgQuery = useQuery({
    queryKey: ["cfg", focusFn],
    queryFn: () => api.cfg(focusFn),
    enabled: visible && callMode && focusFn >= 0 && gs.lod === "near",
    retry: false,
  });
  const cfgModel = useMemo(
    () => (cfgQuery.data !== undefined && cfgQuery.data.fn === focusFn ? buildCfgModel({ fn: focusFn, cfg: cfgQuery.data }) : null),
    [cfgQuery.data, focusFn],
  );

  // Bur 9 / spec 25 §5b: the canvas draws the model AT THE CURRENT LEVEL -
  // `far` bundles the neighbourhood by module, `mid`/`near` draw it as
  // fetched (near only changes how the focus node renders). Pure derivation,
  // no extra fetch: zooming never loads the bundle.
  const drawn = useMemo(() => modelForLevel(model, gs.lod, cfgModel), [model, gs.lod, cfgModel]);
  /** True exactly when the canvas is showing spec 25 mode 3 (the blocks),
   *  rather than the call neighbourhood - `modelForLevel` decides, this only
   *  reads its decision, so the pane and the model can never disagree. */
  const drawnIsCfg = cfgModel !== null && drawn === cfgModel;

  // Bur 11 / spec 25 §5c: lay out FOR THE FRAME. The canvas element is
  // measured with a ResizeObserver (the pane is ~280 px wide docked and the
  // whole window maximised, and the right answer differs) and handed to
  // `layoutGraph`, which wraps each rank into rows that fit. Rounded to whole
  // pixels so a sub-pixel resize cannot re-run the layout forever.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const apply = (w: number, h: number): void => {
      setFrame((prev) => (prev !== null && prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    apply(Math.round(el.clientWidth), Math.round(el.clientHeight));
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) apply(Math.round(box.width), Math.round(box.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [target, gs.maximised]);

  const layout = useMemo(
    // The taller focus box is the CARD's; a CFG entry block is an ordinary
    // node, so the near level only reserves the extra height when the card
    // is what it is actually drawing.
    () => layoutGraph(drawn, { frame, ...(gs.lod === "near" && !drawnIsCfg ? { focusHeight: NODE_H_NEAR } : {}) }),
    [drawn, gs.lod, frame, drawnIsCfg],
  );
  const positions = layout.positions;

  // A frame change that actually changes the GRID (not every pixel of a
  // resize) re-fits, so the analyst sees the new arrangement whole. Skipped
  // while manual drag offsets exist: bur 8's positions are the analyst's, and
  // a resize must not yank the view out from under them.
  const grid = `${layout.columns}:${layout.nodeWidth}`;
  const hasDrags = gs.dragPositions.size > 0;
  useEffect(() => {
    if (hasDrags) return;
    const id = requestAnimationFrame(() => rfInstance.current?.fitView({ padding: FIT_PADDING, maxZoom: 1.1 }));
    return () => cancelAnimationFrame(id);
  }, [grid, hasDrags]);
  const focusId = useMemo(() => drawn.nodes.find((n) => n.isFocus)?.id ?? null, [drawn]);
  const focusCard = useMemo(
    () => (gs.lod === "near" && focusId !== null && !drawnIsCfg ? lodCard(drawn, focusId) : null),
    [gs.lod, drawn, focusId, drawnIsCfg],
  );

  // Bur 8: hovering a node highlights it. Bur 10: with `follow` on, so does
  // a listing selection that resolves to one of the graph's own drawn
  // neighbours (a call site whose callee is in the neighbourhood). Hover
  // always wins when both are present — it is the more immediate signal.
  const highlightId = gs.hoverNode ?? (gs.follow ? calleeNodeForSelection(drawn, sel) : null);
  const active: NeighbourSet | null = useMemo(
    () => (highlightId !== null ? neighbourSet(drawn, highlightId) : null),
    [drawn, highlightId],
  );

  const flowNodes: HbcFlowNode[] = useMemo(
    () =>
      drawn.nodes.map((n) => ({
        id: n.id,
        type: "hbc" as const,
        position: gs.dragPositions.get(n.id) ?? positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          model: n,
          onExpand: expandGraphNode,
          highlighted: active !== null && active.nodes.has(n.id),
          dimmed: active !== null && !active.nodes.has(n.id),
          level: gs.lod,
          card: n.isFocus ? focusCard : null,
          width: layout.nodeWidth,
        },
      })),
    [drawn, positions, gs.dragPositions, active, gs.lod, focusCard, layout.nodeWidth],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      drawn.edges.map((e) => {
        const isActive = active !== null && active.edges.has(e.id);
        // Spec 26 L9 edge art direction, tokens only: an unproven by-name
        // candidate and an exception edge are BOTH drawn in `text-muted`
        // (they are the two "not the straight line" cases), and the dash
        // pattern tells them apart from a taken/not-taken branch. Colour is
        // never used to encode a branch outcome - the T/F label is.
        const dashed = e.byName ? "4 3" : e.cfgKind === "exception" ? "2 4" : e.cfgKind === "branch-not-taken" ? "5 3" : undefined;
        const muted = e.byName || e.cfgKind === "exception";
        const stroke = isActive ? "var(--accent)" : muted ? "var(--text-muted)" : "var(--border)";
        // A far-level bundle carries how many edges it stands for: shown as
        // a label and a (bounded) thicker stroke, never a silent merge.
        const bundled = e.weight > 1;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: bundled ? String(e.weight) : (e.cfgLabel !== undefined && e.cfgLabel !== "" ? e.cfgLabel : undefined),
          labelStyle: { fill: "var(--text-muted)", fontSize: 9 },
          labelBgStyle: { fill: "var(--surface)" },
          style: {
            stroke,
            strokeDasharray: dashed,
            strokeWidth: isActive ? 2 : Math.min(1 + (bundled ? Math.log2(e.weight) : 0), 4),
            opacity: active !== null && !isActive ? 0.35 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      }),
    [drawn, active],
  );

  const body = (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-graph-nodes={drawn.shown}
      data-graph-mode={drawnIsCfg ? "cfg" : target?.kind === "module" ? "module" : "call"}
      data-graph-columns={layout.columns}
      data-graph-node-width={layout.nodeWidth}
    >
      {target === null ? (
        <div className="p-3 text-xs text-text-muted">select a function or a module to graph its neighbourhood</div>
      ) : (
        <div ref={canvasRef} className="min-h-0 flex-1">
          <ReactFlow
            key={`${target.kind}:${target.ref}`}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: FIT_PADDING, maxZoom: 1.1 }}
            minZoom={0.15}
            nodesConnectable={false}
            edgesFocusable={false}
            nodesDraggable
            onInit={(inst) => {
              rfInstance.current = inst;
            }}
            onMove={(event, viewport) => {
              // Bur 9: only a USER gesture (wheel/pinch/zoom-drag) moves the
              // level. React Flow passes `null` for its own programmatic
              // moves (`fitView`, the Controls buttons), and the pane fitting
              // itself must never change the level under the analyst.
              if (event !== null) setGraphLodFromZoom(viewport.zoom);
            }}
            onNodesChange={(changes) => {
              for (const c of changes) {
                if (c.type === "position" && c.position) setNodePosition(c.id, c.position);
              }
            }}
            onNodeMouseEnter={(_e, node) => setHoverNode(node.id)}
            onNodeMouseLeave={() => setHoverNode(null)}
            onNodeClick={(_e, node) => {
              const m = node.data.model;
              // Spec 26 L9: a BLOCK is not navigable as a function - clicking
              // it selects the listing lines it was compiled from, through
              // the same `select()` the listing and the xref panes use, so
              // the centre pane scrolls and highlights exactly as it does
              // for any other jump. A block the render mapped no line into
              // selects nothing rather than a neighbouring block's line.
              if (m.kind === "block") {
                const line = m.block?.listingLine ?? null;
                if (line !== null && focusFn >= 0) select({ kind: "fn", fn: focusFn, line });
                return;
              }
              if (m.ref >= 0 && !m.isFocus) focusGraphNode({ kind: m.kind, ref: m.ref });
            }}
            onNodeDoubleClick={(_e, node) => {
              const m = node.data.model;
              if (m.ref < 0 || m.kind === "block") return;
              // Bur 14 (docs/UI-BURS.md #14): actually land on the code —
              // select AND reveal the listing (un-maximise the graph if it
              // is covering the whole window).
              openGraphTargetInListing({ kind: m.kind, ref: m.ref });
            }}
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
      {drawn.hidden > 0 ? <GraphTruncationBar shown={drawn.shown} hidden={drawn.hidden} /> : null}
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
      <span className="ml-auto shrink-0">{drawn.shown} nodes</span>
      <button
        type="button"
        data-graph-lod={gs.lod}
        onClick={() => {
          const next = cycleGraphLod();
          requestAnimationFrame(() => rfInstance.current?.zoomTo(LOD_NOMINAL_ZOOM[next]));
        }}
        className="shrink-0 rounded-ui px-1 font-mono hover:bg-surface-2"
        title="semantic zoom: far (modules) - mid (functions) - near (the focus opened up). Zooming with the wheel does the same."
      >
        lod:{gs.lod}
      </button>
      <button
        type="button"
        data-graph-follow={gs.follow ? "true" : "false"}
        aria-pressed={gs.follow}
        onClick={() => setGraphFollow(!gs.follow)}
        className={`shrink-0 rounded-ui px-1 hover:bg-surface-2 ${gs.follow ? "text-accent" : "text-text-muted"}`}
        title={gs.follow ? "following the listing selection — click to stop" : "not following the listing selection — click to follow"}
      >
        follow
      </button>
      <button
        type="button"
        data-graph-reset
        disabled={target === null}
        onClick={() => {
          // Spec 25 §5b: reset returns to the level the neighbourhood was
          // rooted at, and fits at that level's nominal zoom, so the level
          // the pane reports and the zoom it is at cannot disagree.
          const level = gs.rootLod;
          resetGraphView();
          requestAnimationFrame(() =>
            rfInstance.current?.fitView({ padding: FIT_PADDING, minZoom: LOD_NOMINAL_ZOOM[level], maxZoom: LOD_NOMINAL_ZOOM[level] }));
        }}
        className="shrink-0 rounded-ui px-1 hover:bg-surface-2 disabled:opacity-40"
        title="reset the graph to the default layout and fit it to view"
      >
        reset view
      </button>
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
      data-graph-lod-level={gs.lod}
      className={gs.maximised ? "fixed inset-0 z-50 flex flex-col bg-bg" : "flex h-full min-h-0 flex-col"}
    >
      {header}
      {body}
    </div>
  );
}
