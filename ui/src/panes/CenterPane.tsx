// ui/src/panes/CenterPane.tsx — the listing (spec 22 §3.2, plus the owner's
// wave-2 request): an analyst reads a FILE, not a function. Selecting a
// module shows the whole module source with every function's range marked;
// selecting a function keeps the same document and scrolls to its range
// instead of swapping the listing. Only when the module has no file view
// (404) does the pane fall back to `/api/fn/{fn}/source`.
//
// Below it, folded away by the bar at the bottom, is `/api/fn/{fn}/disasm`
// for the selected function. Both blocks are CodeMirror 6 (../listing).
//
// The pane is driven by the selection store: clicking a word sets an
// `identifier` selection (name + line), which is what the context menu's
// Rename and the palette's annotate actions read out of
// `ActionContext.selection`; clicking anywhere inside a marked function
// range selects that function.
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaneHeader } from "../components/primitives.tsx";
import {
  isMissingResource, useContextResource, useDisasm, useFn, useLineMap, useModule, useModuleSource, useSource,
} from "../hooks.ts";
import { CodeView } from "../listing/CodeView.tsx";
import { displayName } from "../listing/names.ts";
import { clampLines, MAX_RENDER_LINES, MAX_RENDER_LINES_MODULE } from "../listing/truncate.ts";
import { select, useSelection } from "../state/selection.ts";
import type { ModuleSourceFn } from "../contracts.ts";
import { setDisasmOpen, useDisasmOpen } from "./disasm-store.ts";
import { alignedDisasmLine } from "../listing/line-map.ts";

function TruncationBar({ hidden, shown, cap }: { readonly hidden: number; readonly shown: number; readonly cap: number }): ReactNode {
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3 text-xs text-text-muted">
      <span className="text-text">truncated</span>
      <span>
        showing the first {shown.toLocaleString()} lines, {hidden.toLocaleString()} more not rendered
        {shown >= cap ? " (listing cap)" : " (server cap)"}
      </span>
    </div>
  );
}

function Notice({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="p-3 text-xs text-text-muted">{children}</div>;
}

/** True once `loading` has been continuously true for `delayMs` — drives the
 *  cold-start hint (docs/UI.md "Cold start"): on a large bundle, the FIRST
 *  `/api/fn/{fn}/locals` or `/api/module/{id}/source` query after `ui-server`
 *  starts can take tens of seconds (`ArtifactService.warmFrames`'s prewarm
 *  usually beats it, but not always — a request right at start, or a
 *  `--no-prewarm` server, still pays for it). After a full second stuck
 *  loading, say why instead of leaving a bare "loading…" spinner. */
function useSlowLoading(loading: boolean, delayMs = 1000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(t);
  }, [loading, delayMs]);
  return slow;
}

/** The function whose range contains `line`, if any. */
export function fnAtLine(fns: readonly ModuleSourceFn[], line: number): ModuleSourceFn | null {
  for (const f of fns) if (line >= f.lines[0] && line <= f.lines[1]) return f;
  return null;
}

export function CenterPane({ fn }: { readonly fn: number }): ReactNode {
  const sel = useSelection();
  const hasFn = sel.fn !== undefined;
  const fnId = sel.fn ?? fn;
  const meta = useFn(hasFn ? fnId : -1);
  const ctx = useContextResource(hasFn ? fnId : -1);

  // Which module's file are we reading? An explicit module selection wins;
  // otherwise the selected function's own module.
  const selectedModule = sel.kind === "module" && sel.moduleId !== undefined ? Number(sel.moduleId) : null;
  const moduleId = selectedModule ?? meta.data?.module ?? null;
  const mod = useModule(moduleId ?? -1);
  const file = useModuleSource(moduleId ?? -1);
  const fileMissing = file.isError && isMissingResource(file.error);

  // Fall back to the per-function listing only when the file view is absent.
  const useFileView = file.data !== undefined;
  const fnSource = useSource(useFileView || !hasFn ? -1 : fnId);
  const disasm = useDisasm(hasFn ? fnId : -1);
  const lineMap = useLineMap(hasFn ? fnId : -1);
  const disasmOpen = useDisasmOpen();
  const disasmPanel = useRef<ImperativePanelHandle | null>(null);
  const disasmBody = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const p = disasmPanel.current;
    if (p === null) return;
    if (disasmOpen) p.expand();
    else p.collapse();
  }, [disasmOpen]);

  // `view.rawHermes` (../actions/registry.ts) opens the panel from outside
  // this component; once it is open (here or via the toggle bar), scroll it
  // fully into view and hand it keyboard focus.
  useEffect(() => {
    if (!disasmOpen) return;
    disasmBody.current?.scrollIntoView({ block: "nearest" });
    disasmBody.current?.querySelector<HTMLElement>(".cm-content")?.focus();
  }, [disasmOpen]);

  const body = useFileView
    ? { text: file.data!.text, totalLines: file.data!.text.split("\n").length, truncated: false }
    : { text: fnSource.data?.text ?? "", totalLines: fnSource.data?.totalLines ?? 0, truncated: fnSource.data?.truncated ?? false };
  // The whole-module file view (spec 22 §2's editor cap, lifted per Fred's
  // "file view must show the whole module") gets a much higher ceiling than
  // the per-function view — CodeMirror 6 virtualises the viewport itself
  // (see `../listing/truncate.ts`'s doc comment for the measurement), so
  // this costs nothing until a module is pathologically large.
  const srcCap = useFileView ? MAX_RENDER_LINES_MODULE : MAX_RENDER_LINES;
  const src = useMemo(() => clampLines(body.text, body.totalLines, body.truncated, srcCap), [body.text, body.totalLines, body.truncated, srcCap]);
  const dis = useMemo(
    () => clampLines(disasm.data?.text ?? "", disasm.data?.totalLines ?? 0, disasm.data?.truncated ?? false),
    [disasm.data],
  );

  const fns = file.data?.functions ?? [];
  const marks = useMemo(() => fns.map((f) => f.lines[0]), [fns]);
  const range = useFileView && hasFn ? (fns.find((f) => f.fn === fnId) ?? null) : null;

  // Where to park the highlight: the line the user clicked, else the start
  // of the selected function's range in the file view.
  const line = sel.line !== undefined && (sel.fn === fnId || sel.kind === "module")
    ? sel.line
    : range?.lines[0] ?? null;

  // Source -> disasm alignment (docs/specs/05-emitter.md §16): the cursor line
  // maps to the instruction behind it, and the disassembly pane highlights and
  // scrolls to that instruction's own line. `null` whenever the map has nothing
  // honest for this line, in which case the pane keeps its own scroll position.
  const disasmLine = useMemo(
    () =>
      alignedDisasmLine({
        rows: lineMap.data?.lines ?? [],
        fn: fnId,
        editorLine: line,
        fileView: useFileView,
        fnStartLine: lineMap.data?.fnStartLine ?? null,
        disasmText: dis.text,
      }),
    [lineMap.data, fnId, line, useFileView, dis.text],
  );

  const name = displayName(fnId, ctx.data?.metadata, meta.data);
  const sourceMissing = !useFileView && hasFn && fnSource.isError && isMissingResource(fnSource.error);

  const listingLoading = file.isLoading || fnSource.isLoading;
  const listingSlow = useSlowLoading(listingLoading);

  const listing = ((): ReactNode => {
    if (!hasFn && selectedModule === null) return <Notice>select a module or a function on the left</Notice>;
    if (listingLoading) return <Notice>{listingSlow ? "analysing the bundle (first request after start is slow)" : "loading listing…"}</Notice>;
    if (sourceMissing) return <Notice>no listing recorded for fn {fnId} (the bundle records no source range for it)</Notice>;
    if (!useFileView && fnSource.isError) return <Notice>could not load the listing for fn {fnId}</Notice>;
    if (!useFileView && fileMissing && !hasFn) return <Notice>module {moduleId} has no file view</Notice>;
    return (
      <CodeView
        text={src.text}
        language="javascript"
        highlightLine={line}
        markedLines={marks}
        ariaLabel={useFileView ? `source of module ${moduleId}` : `source of function ${fnId}`}
        registerFold
        onIdentifier={(token, at) => select({ kind: "identifier", fn: fnId, name: token, line: at })}
        onLine={(at) => {
          const hit = useFileView ? fnAtLine(fns, at) : null;
          if (hit !== null && hit.fn !== sel.fn) select({ kind: "fn", fn: hit.fn, line: at });
        }}
      />
    );
  })();

  return (
    <section className="flex h-full min-w-0 flex-col bg-bg">
      <PaneHeader>
        <span className="truncate font-mono text-text" title={file.data?.file ?? meta.data?.file ?? undefined}>
          {file.data?.file ?? mod.data?.file ?? (hasFn ? name : "no selection")}
        </span>
        {hasFn && <span className="shrink-0 font-mono">{name}</span>}
        {hasFn && <span className="shrink-0">fn {fnId}</span>}
        {moduleId !== null && <span className="shrink-0">module {moduleId}</span>}
        {useFileView && <span className="shrink-0">{fns.length} fns</span>}
        <span className="shrink-0">{src.total.toLocaleString()} lines</span>
        {range !== null && <span className="shrink-0 font-mono">@{range.lines[0]}–{range.lines[1]}</span>}
        {meta.data?.degraded != null && <span className="shrink-0 text-sev-high">degraded: {meta.data.degraded}</span>}
        <span className="ml-auto shrink-0">{sel.kind === "identifier" ? `selected: ${sel.name}` : ""}</span>
      </PaneHeader>
      <PanelGroup direction="vertical" autoSaveId="hbc2js.listing" className="min-h-0 flex-1">
        <Panel defaultSize={62} minSize={15} className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">{listing}</div>
          {src.hidden !== null && src.hidden > 0 && <TruncationBar hidden={src.hidden} shown={src.shown} cap={srcCap} />}
        </Panel>
        <PanelResizeHandle className="h-px bg-border data-[resize-handle-state=drag]:bg-accent data-[resize-handle-state=hover]:bg-accent" />
        <Panel
          ref={disasmPanel}
          collapsible
          collapsedSize={0}
          defaultSize={38}
          minSize={15}
          onCollapse={() => setDisasmOpen(false)}
          onExpand={() => setDisasmOpen(true)}
          className="min-h-0 bg-surface"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div ref={disasmBody} className="min-h-0 flex-1">
              {!hasFn ? (
                <Notice>no function selected</Notice>
              ) : disasm.isLoading ? (
                <Notice>loading disassembly…</Notice>
              ) : disasm.isError ? (
                <Notice>{isMissingResource(disasm.error) ? `no disassembly for fn ${fnId}` : "could not load the disassembly"}</Notice>
              ) : (
                <CodeView text={dis.text} language="plain" highlightLine={disasmLine} ariaLabel={`disassembly of function ${fnId}`} />
              )}
            </div>
            {dis.hidden !== null && dis.hidden > 0 && <TruncationBar hidden={dis.hidden} shown={dis.shown} cap={MAX_RENDER_LINES} />}
          </div>
        </Panel>
      </PanelGroup>
      <button
        type="button"
        onClick={() => setDisasmOpen(!disasmOpen)}
        className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-surface px-3 text-left text-xs text-text-muted hover:text-text"
        aria-expanded={disasmOpen}
        data-testid="disasm-fold"
      >
        <span className="font-mono">{disasmOpen ? "v" : ">"}</span>
        <span>disasm{hasFn ? ` · fn ${fnId}` : ""}</span>
        <span className="ml-auto font-mono">{dis.total.toLocaleString()} lines</span>
      </button>
    </section>
  );
}
