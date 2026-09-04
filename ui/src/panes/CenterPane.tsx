// ui/src/panes/CenterPane.tsx — the listing: monospace source over a disasm
// block, draggable vertical split. PLACEHOLDER renderer: landing 2 replaces
// both blocks with CodeMirror 6 (source) and the disasm view, keeping this
// layout and these data hooks.
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ReactNode } from "react";
import { PaneHeader } from "../components/primitives.tsx";
import { useDisasm, useFn, useSource } from "../hooks.ts";

function CodeBlock({ text, loading }: { readonly text: string | undefined; readonly loading: boolean }): ReactNode {
  return (
    <pre className="hbc-scroll m-0 h-full overflow-auto p-3 font-mono text-xs leading-relaxed text-text">
      {loading ? "loading..." : text}
    </pre>
  );
}

export function CenterPane({ fn }: { readonly fn: number }): ReactNode {
  const meta = useFn(fn);
  const source = useSource(fn);
  const disasm = useDisasm(fn);
  return (
    <section className="flex h-full min-w-0 flex-col bg-bg">
      <PaneHeader>
        <span className="font-mono text-text">{meta.data?.name ?? `fn ${fn}`}</span>
        <span>fn {fn}</span>
        {meta.data?.file !== undefined && meta.data.file !== null && <span className="truncate">{meta.data.file}</span>}
        <span className="ml-auto">source over disasm (placeholder; CodeMirror lands next)</span>
      </PaneHeader>
      <PanelGroup direction="vertical" autoSaveId="hbc2js.listing" className="min-h-0 flex-1">
        <Panel defaultSize={62} minSize={15} className="min-h-0">
          <CodeBlock text={source.data?.text} loading={source.isLoading} />
        </Panel>
        <PanelResizeHandle className="h-px bg-border data-[resize-handle-state=drag]:bg-accent data-[resize-handle-state=hover]:bg-accent" />
        <Panel defaultSize={38} minSize={15} className="min-h-0 bg-surface">
          <div className="flex h-6 items-center border-b border-border px-3 text-xs text-text-muted">disasm</div>
          <div className="h-[calc(100%-1.5rem)]">
            <CodeBlock text={disasm.data?.text} loading={disasm.isLoading} />
          </div>
        </Panel>
      </PanelGroup>
    </section>
  );
}
