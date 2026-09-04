// ui/src/graph/nodes.tsx — the custom React Flow node (spec 25 §5). Reads
// EXISTING theme tokens only (bg-surface / border-border / text-text /
// text-text-muted / text-sev-* / rounded-ui): no new palette, no literal
// colours, same art direction as every other pane.
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import type { GraphNodeModel } from "./model.ts";
import { NODE_H, NODE_W } from "./layout.ts";

/** Below this zoom the labels come off and a node is just a token-coloured
 *  box — spec 25 §5's level-of-detail rule, the cheap answer to a wide
 *  neighbourhood before anything heavier (D28). */
export const LOD_ZOOM = 0.55;

/** A type ALIAS (not an interface) on purpose: React Flow's `Node<T>`
 *  requires `T extends Record<string, unknown>`, which only an alias of an
 *  object literal type satisfies implicitly. */
export type HbcNodeData = {
  readonly model: GraphNodeModel;
  readonly onExpand: (fn: number) => void;
  /** Bur 8/10: this node is in the active highlight's neighbour set (hover,
   *  or the follow-toggle's call-site match) — an accent ring, never a new
   *  colour. `dimmed` is the complement: something else is highlighted and
   *  this node is not part of it. Both false when nothing is highlighted. */
  readonly highlighted: boolean;
  readonly dimmed: boolean;
};

export type HbcFlowNode = Node<HbcNodeData, "hbc">;

const SEVERITY_CLASS: Readonly<Record<string, string>> = {
  critical: "bg-sev-crit",
  high: "bg-sev-high",
  med: "bg-sev-med",
  low: "bg-sev-ok",
};

const handleClass = "!h-1 !w-1 !border-0 !bg-border";

export function HbcNode({ data, positionAbsoluteX, positionAbsoluteY }: NodeProps<HbcFlowNode>): ReactNode {
  const zoom = useStore((s) => s.transform[2]);
  const lod = zoom < LOD_ZOOM ? "min" : "full";
  const m = data.model;
  const border = m.isFocus ? "border-accent" : m.byName ? "border-dashed border-border" : "border-border";
  const text = m.byName ? "text-text-muted" : "text-text";
  const ring = data.highlighted && !m.isFocus ? "ring-2 ring-accent" : "";
  const fade = data.dimmed ? "opacity-40" : "";
  return (
    <div
      data-graph-node={m.id}
      data-graph-focus={m.isFocus ? "true" : "false"}
      data-graph-byname={m.byName ? "true" : "false"}
      data-graph-highlighted={data.highlighted ? "true" : "false"}
      data-graph-dimmed={data.dimmed ? "true" : "false"}
      data-graph-x={Math.round(positionAbsoluteX)}
      data-graph-y={Math.round(positionAbsoluteY)}
      data-lod={lod}
      style={{ width: NODE_W, height: NODE_H }}
      className={`flex flex-col justify-center gap-0.5 overflow-hidden rounded-ui border bg-surface px-2 ${border} ${ring} ${fade}`}
      title={m.byName ? `${m.label} — heuristic by-name candidate, not a proven edge` : m.label}
    >
      <Handle type="target" position={Position.Top} className={handleClass} />
      {lod === "full" ? (
        <>
          <div className="flex items-center gap-1">
            {m.severity !== null ? (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_CLASS[m.severity] ?? "bg-sev-ok"}`} />
            ) : null}
            <span className={`truncate font-mono text-xs ${text}`}>{m.label}</span>
            {m.ref >= 0 && m.kind === "fn" && !m.expanded ? (
              <button
                type="button"
                data-graph-expand={m.ref}
                aria-label={`expand ${m.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onExpand(m.ref);
                }}
                className="ml-auto shrink-0 rounded-ui px-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
              >
                +
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            {m.module !== null ? <span className="truncate rounded-ui bg-surface-2 px-1">mod {m.module}</span> : null}
            {m.size !== null ? <span className="shrink-0">{m.size} B</span> : null}
            {m.byName ? <span className="shrink-0">by-name</span> : null}
          </div>
        </>
      ) : (
        <div className={`h-2 w-full rounded-ui ${m.isFocus ? "bg-accent" : "bg-surface-2"}`} />
      )}
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  );
}

export const nodeTypes = { hbc: HbcNode };
