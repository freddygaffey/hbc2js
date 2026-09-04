// ui/src/actions/registry.ts — spec 22 §3.1's single source, instantiated
// for the browser: ONE `createStandardRegistry()` from @ui-core/actions.ts,
// ONE `createKeymap()` over the preset named in ui/keymap.json, and the
// `ActionApi` implementation that binds them to the selection store, the
// query cache and `/api/tools/*`. The context menu, the palette and the
// keydown listener all read from here; none of them keeps its own list.
import type { QueryClient } from "@tanstack/react-query";
import {
  createStandardRegistry, type ActionApi, type ActionContext, type FocusPane, type Selection as CoreSelection,
} from "@ui-core/actions.ts";
import { createKeymap } from "@ui-core/keymap.ts";
import { resolveKeymapConfigWith } from "@ui-core/keymap-resolve.ts";
import { PRESETS, keymapConfig } from "../keymap-config.ts";
import type { FunctionCatalogue } from "../hooks.ts";
import { back, forward, getSelection, select, type Selection } from "../state/selection.ts";
import { openDialog, setPaletteOpen, setRightPanel, setStatus } from "./store.ts";
import { addTag, fnTarget } from "./writes.ts";

export const registry = createStandardRegistry();

/** The active keymap: `ui/keymap.json`'s preset plus its overrides,
 *  validated against `registry` (an override naming an unknown action id
 *  throws here, at startup, rather than dying silently at keypress). */
export const keymap = createKeymap(resolveKeymapConfigWith(keymapConfig, registry, PRESETS));

// -- query client -----------------------------------------------------------

let queryClient: QueryClient | null = null;

/** ActionsProvider hands us the app's QueryClient so writes can invalidate
 *  and `next/prev function` can walk the cached catalogue. */
export function setQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

/** Everything a write to `fn` invalidates: its summary, its rendered source
 *  and disasm, its context/xrefs, the catalogue the tree renders from, the
 *  findings list and the log tail (so the write shows up in the log pane). */
export function invalidateFn(fn: number | undefined): void {
  const qc = queryClient;
  if (qc === null) return;
  const keys = ["fn", "source", "disasm", "context", "who-calls", "calls-from"] as const;
  if (fn !== undefined) for (const k of keys) void qc.invalidateQueries({ queryKey: [k, fn] });
  void qc.invalidateQueries({ queryKey: ["functions-all"] });
  void qc.invalidateQueries({ queryKey: ["findings"] });
  void qc.invalidateQueries({ queryKey: ["log-tail"] });
}

// -- helpers ----------------------------------------------------------------

function catalogue(): FunctionCatalogue | undefined {
  return queryClient?.getQueryData<FunctionCatalogue>(["functions-all"]);
}

function stepFn(delta: number): void {
  const rows = catalogue()?.rows ?? [];
  if (rows.length === 0) return setStatus("no function list loaded yet");
  const current = getSelection().fn;
  const at = rows.findIndex((r) => r.fn === current);
  const next = rows[Math.min(rows.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta))];
  if (next !== undefined) select({ kind: "fn", fn: next.fn });
}

function stepModule(delta: number): void {
  const rows = catalogue()?.rows ?? [];
  const modules = [...new Set(rows.map((r) => r.module).filter((m): m is number => m !== null))].sort((a, b) => a - b);
  if (modules.length === 0) return setStatus("no module list loaded yet");
  const currentFn = getSelection().fn;
  const currentModule = rows.find((r) => r.fn === currentFn)?.module ?? modules[0]!;
  const at = modules.indexOf(currentModule);
  const target = modules[Math.min(modules.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta))];
  if (target === undefined) return;
  const first = rows.find((r) => r.module === target);
  if (first !== undefined) select({ kind: "fn", fn: first.fn });
}

function focusSearch(): void {
  const el = document.querySelector<HTMLInputElement>('input[aria-label="search functions"]');
  if (el === null) return setStatus("no search box on screen");
  el.focus();
  el.select();
}

async function tag(target: CoreSelection, which: "reviewed" | "suspicious"): Promise<void> {
  if (target.fn === undefined) return setStatus("select a function first");
  try {
    const res = await addTag(fnTarget(target.fn), which);
    invalidateFn(target.fn);
    setStatus(res.line);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => setStatus(`copied ${text}`),
    () => setStatus(`could not copy ${text} (clipboard blocked)`),
  );
}

/** The core `Selection` is structurally the shell's minus `line`. */
function asShellSelection(s: CoreSelection): Selection {
  return s as Selection;
}

// -- the ActionApi ----------------------------------------------------------

export const actionApi: ActionApi = {
  setName: (target) => openDialog("rename", asShellSelection(target)),
  addComment: (target) => openDialog("comment", asShellSelection(target)),
  recordFinding: (target) => openDialog("finding", asShellSelection(target)),
  gotoFn: (fn) => select({ kind: "fn", fn }),
  showXrefs: (target) => {
    if (target.fn !== undefined) select({ kind: "fn", fn: target.fn });
    setRightPanel("xrefs");
  },
  search: () => focusSearch(),
  openPalette: () => setPaletteOpen(true),
  markReviewed: (target) => tag(target, "reviewed"),
  markSuspicious: (target) => tag(target, "suspicious"),
  copyDisasmOffset: (target) => copy(target.fn === undefined ? "" : `fn:${target.fn}`),
  showRawHermes: () => setStatus("raw Hermes is the centre pane's Disasm tab"),
  explain: () => setStatus("Explain lands with the AI spec"),
  suggestName: () => setStatus("Suggest name lands with the AI spec"),
  openGraph: () => setStatus("the graph view lands with spec 23"),
  nextFn: () => stepFn(1),
  prevFn: () => stepFn(-1),
  nextModule: () => stepModule(1),
  prevModule: () => stepModule(-1),
  back: () => void back(),
  forward: () => void forward(),
  fold: () => setStatus("folding is a listing follow-up"),
  unfold: () => setStatus("folding is a listing follow-up"),
};

/** Which pane has focus right now — actions may gate on it (`when`). */
export function focusPane(): FocusPane {
  const el = document.activeElement;
  if (el instanceof HTMLElement) {
    if (el.closest(".cm-editor") !== null) return "editor";
    if (el.closest('[data-pane="tree"]') !== null) return "tree";
    if (el.matches('input[aria-label="search functions"]')) return "search";
  }
  return "editor";
}

/** The `ActionContext` every surface passes to the registry: the CURRENT
 *  selection, read fresh (never a React snapshot — a keydown handler outside
 *  the tree must see the same selection the tree just set). */
export function actionContext(selection?: Selection): ActionContext {
  return { selection: (selection ?? getSelection()) as CoreSelection, focusPane: focusPane(), api: actionApi };
}

/** Run an action by id if it is enabled; returns false when it is not (the
 *  keydown listener uses that to leave the key to the browser). */
export function runAction(id: string, selection?: Selection): boolean {
  const ctx = actionContext(selection);
  const action = registry.get(id);
  if (action === undefined) return false;
  if (action.when !== undefined && !action.when(ctx)) {
    setStatus(`${action.title}: not available for the current selection`);
    return false;
  }
  void registry.run(id, ctx);
  return true;
}
