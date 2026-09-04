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
// The pane is driven by the selection store, and the unit of selection is a
// TOKEN, not a character offset (bur 2, ../listing/token.ts): one click
// selects the whole word under the pointer and produces ONE selection —
// `identifier` when the token names something, otherwise the function whose
// marked range the line falls in, otherwise the module. That selection is
// what the context menu's Rename and the palette's annotate actions read out
// of `ActionContext.selection`.
//
// Double-click ACTIVATES the token: go to what it names (bur 7). It never
// navigates blindly — a keyword (`function`), a literal or punctuation is
// refused before any lookup, and a name that resolves to no function flashes
// "no target" in the header instead of moving the selection.
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PaneHeader } from "../components/primitives.tsx";
import {
  isMissingResource, useContextResource, useDisasm, useFn, useLineMap, useModule, useModuleSource, useSource,
} from "../hooks.ts";
import { CodeView } from "../listing/CodeView.tsx";
import { displayName } from "../listing/names.ts";
import { clampLines, MAX_RENDER_LINES, MAX_RENDER_LINES_MODULE } from "../listing/truncate.ts";
import { select, useSelection } from "../state/selection.ts";
import { api } from "../api.ts";
import { isNameLike, isNavigable, type ListingToken } from "../listing/token.ts";
import type { FunctionMatch, ModuleSourceFn, SearchPage } from "../contracts.ts";
import { setDisasmOpen, useDisasmOpen } from "./disasm-store.ts";
import { disasmLineForOffset, fnLocalLine, rowForLineAcrossFns } from "../listing/line-map.ts";

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
  // otherwise the selected function's own module. An `identifier`/`string`
  // selection carries the module it was clicked in too (bur 7): clicking a
  // word in a module file view whose line belongs to no function used to
  // drop the module context entirely — `moduleId` went null, the file view
  // was replaced by a per-function listing for a function that did not
  // exist, and the pane went blank.
  const selectedModule =
    sel.moduleId !== undefined && (sel.kind === "module" || sel.kind === "identifier" || sel.kind === "string")
      ? Number(sel.moduleId)
      : null;
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

  const fns = file.data?.functions ?? [];
  const marks = useMemo(() => fns.map((f) => f.lines[0]), [fns]);
  const range = useFileView && hasFn ? (fns.find((f) => f.fn === fnId) ?? null) : null;

  // Where to park the highlight: the line the user clicked, else the start
  // of the selected function's range in the file view.
  const line = sel.line !== undefined && (sel.fn === fnId || sel.kind === "module")
    ? sel.line
    : range?.lines[0] ?? null;

  // Source -> disasm alignment (docs/specs/05-emitter.md §16): the cursor line
  // maps to the instruction behind it. Since §16.2's inline-function mapping,
  // that instruction may belong to a nested closure printed inline inside
  // this function's own listing (`ui/src/listing/line-map.ts`'s
  // `rowForLineAcrossFns`) — the honest disasm to show is then the CHILD's
  // own, not the nearest preceding line in the parent's.
  const resolvedRow = useMemo(
    () => rowForLineAcrossFns(lineMap.data?.lines ?? [], fnId, fnLocalLine(line, useFileView, lineMap.data?.fnStartLine ?? null)),
    [lineMap.data, fnId, line, useFileView],
  );
  const nestedFn = resolvedRow?.nested === true ? resolvedRow.fn : null;
  // Always called, never conditionally (React hook rule) — disabled (fn -1)
  // when the cursor is not currently inside a nested closure.
  const nestedDisasm = useDisasm(nestedFn ?? -1);

  // No flicker: the disasm pane keeps showing whatever it last had (the
  // parent's own listing, or a previously-loaded nested closure's) until the
  // NEWLY resolved target's own data has actually arrived, rather than
  // blanking or reverting to a loading message while it fetches. A genuine
  // function switch (a different `fnId`, e.g. an xref jump) still clears it,
  // so that case keeps its own honest loading/error state below.
  type ShownDisasm = {
    readonly parentFn: number;
    readonly fn: number;
    readonly text: string;
    readonly totalLines: number;
    readonly truncated: boolean;
    readonly highlightLine: number | null;
    readonly nestedHeader: { readonly child: number; readonly parent: number } | null;
  };
  const shownRef = useRef<ShownDisasm | null>(null);
  if (shownRef.current !== null && shownRef.current.parentFn !== fnId) shownRef.current = null;
  const activeFn = nestedFn ?? fnId;
  const activeQuery = nestedFn !== null ? nestedDisasm : disasm;
  if (activeQuery.data !== undefined) {
    const highlightLine =
      resolvedRow !== null && resolvedRow.fn === activeFn ? disasmLineForOffset(activeQuery.data.text, resolvedRow.row[2]) : null;
    shownRef.current = {
      parentFn: fnId,
      fn: activeFn,
      text: activeQuery.data.text,
      totalLines: activeQuery.data.totalLines,
      truncated: activeQuery.data.truncated,
      highlightLine,
      nestedHeader: nestedFn !== null ? { child: nestedFn, parent: fnId } : null,
    };
  }
  const shown = shownRef.current;
  const dis = useMemo(
    () => clampLines(shown?.text ?? "", shown?.totalLines ?? 0, shown?.truncated ?? false),
    [shown],
  );
  const disasmLine = shown?.highlightLine ?? null;
  const nestedHeader = shown?.nestedHeader ?? null;

  const name = displayName(fnId, ctx.data?.metadata, meta.data);
  const sourceMissing = !useFileView && hasFn && fnSource.isError && isMissingResource(fnSource.error);

  // Bur 7: a double-click that resolves to nothing says so instead of
  // navigating. Transient, header-only; the selection does not move.
  const [noTarget, setNoTarget] = useState<string | null>(null);
  const noTargetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashNoTarget = (label: string): void => {
    if (noTargetTimer.current !== null) clearTimeout(noTargetTimer.current);
    setNoTarget(label);
    noTargetTimer.current = setTimeout(() => setNoTarget(null), 2500);
  };
  useEffect(() => () => {
    if (noTargetTimer.current !== null) clearTimeout(noTargetTimer.current);
  }, []);

  // The listing's own symbol map: the functions this module file declares,
  // by name. Free (the file view already carries them) and the first place
  // a double-clicked identifier is looked up.
  const nameToFn = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fns) if (f.name !== null && f.name !== "" && !m.has(f.name)) m.set(f.name, f.fn);
    return m;
  }, [fns]);
  const qc = useQueryClient();

  /** The function whose header line `at` is, when `name` is the name that
   *  header declares (not one of its parameters, which sit on the same
   *  line). `null` in the per-function view, which has no ranges. */
  const declaredFnAt = (at: number, name: string): number | null => {
    if (!useFileView) return null;
    const f = fns.find((x) => x.lines[0] === at);
    if (f === undefined) return null;
    const lineText = src.text.split("\n")[at - 1] ?? "";
    const m = /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(lineText);
    return m !== null && m[1] === name ? f.fn : null;
  };

  /** Single click: select the token under the pointer (bur 2). ONE selection
   *  per click — the fn the line belongs to and the token are the same
   *  event, and pushing two entries filled the jump list with pairs and let
   *  the second one (built from a stale `fnId`) undo the first. */
  const selectToken = (token: ListingToken | null, at: number): void => {
    const hit = useFileView ? fnAtLine(fns, at) : null;
    const containing = hit?.fn ?? (hasFn ? fnId : undefined);
    const base = {
      line: at,
      ...(containing !== undefined && containing >= 0 ? { fn: containing } : {}),
      ...(moduleId !== null ? { moduleId: String(moduleId) } : {}),
    };
    if (token !== null && isNameLike(token.kind)) select({ kind: "identifier", name: token.text, ...base });
    else if (containing !== undefined && containing >= 0) select({ kind: "fn", ...base });
    else if (moduleId !== null) select({ kind: "module", ...base });
  };

  /** Double click: go to what the token names, or nowhere (bur 7). The
   *  token must be name-like (never the keyword `function`, a literal or
   *  punctuation) AND resolve to a real function — this module's own
   *  declarations first, then an exact name match from
   *  `/api/search/functions`, fetched on demand so the pane never pulls the
   *  whole function catalogue just to be ready for a double-click. */
  const activateToken = (token: ListingToken | null, at: number): void => {
    selectToken(token, at);
    if (token === null || !isNavigable(token)) {
      flashNoTarget(token === null ? "nothing" : token.text);
      return;
    }
    const name = token.text;
    // The listing's own symbol conventions, cheapest first.
    //   1. the name printed at a function's own header line (`function
    //      factory(…)` on a marked fn-start line) — the file view already
    //      knows every function's range;
    //   2. `_fn<n>`, the emitter's name for a nested closure (src/emit/
    //      index.ts §6 "Function nesting") — `n` IS the function index, so a
    //      call site like `r1 = _fn75;` is a real, resolvable target;
    //   3. a function this module declares under that name;
    //   4. an exact name match from `/api/search/functions`.
    const declared = declaredFnAt(at, name);
    if (declared !== null) {
      select({ kind: "fn", fn: declared, name });
      return;
    }
    const emitted = /^_fn([0-9]+)$/.exec(name);
    if (emitted !== null) {
      select({ kind: "fn", fn: Number(emitted[1]), name });
      return;
    }
    const local = nameToFn.get(name);
    if (local !== undefined) {
      select({ kind: "fn", fn: local, name });
      return;
    }
    void (async () => {
      let target: number | null = null;
      try {
        const page = await qc.fetchQuery<SearchPage<FunctionMatch>>({
          queryKey: ["search-functions", name],
          staleTime: Infinity,
          queryFn: () => api.searchFunctions(name),
        });
        const exact = page.rows.filter((r) => r.name === name);
        target = exact.length > 0 ? exact[0]!.fn : null;
      } catch {
        target = null;
      }
      if (target === null) flashNoTarget(name);
      else select({ kind: "fn", fn: target, name });
    })();
  };

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
        onSelectToken={selectToken}
        onActivateToken={activateToken}
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
        {noTarget !== null && (
          <span className="shrink-0 text-sev-high" data-testid="code-no-target">no target: {noTarget}</span>
        )}
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
            <div ref={disasmBody} className="flex min-h-0 flex-1 flex-col">
              {!hasFn ? (
                <Notice>no function selected</Notice>
              ) : shown === null && disasm.isLoading ? (
                <Notice>loading disassembly…</Notice>
              ) : shown === null && disasm.isError ? (
                <Notice>{isMissingResource(disasm.error) ? `no disassembly for fn ${fnId}` : "could not load the disassembly"}</Notice>
              ) : shown === null ? (
                <Notice>loading disassembly…</Notice>
              ) : (
                <>
                  {nestedHeader !== null && (
                    <button
                      type="button"
                      onClick={() => select({ kind: "fn", fn: nestedHeader.child })}
                      className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-surface-2 px-3 text-left text-xs text-text-muted hover:text-text"
                      title="jump to this nested closure's own function"
                      data-testid="disasm-nested-header"
                    >
                      <span className="font-mono text-text">fn {nestedHeader.child}</span>
                      <span>— nested closure inside fn {nestedHeader.parent}</span>
                    </button>
                  )}
                  <div className="min-h-0 flex-1">
                    <CodeView text={dis.text} language="disasm" highlightLine={disasmLine} ariaLabel={`disassembly of function ${shown.fn}`} />
                  </div>
                </>
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
