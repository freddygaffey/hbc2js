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
import { createKeymap, type Keymap } from "@ui-core/keymap.ts";
import { mergeBindings, resolveKeymapConfigWith, type KeymapConfig } from "@ui-core/keymap-resolve.ts";
import { useSyncExternalStore } from "react";
import { formatDisasmOffset } from "@ui-core/disasm-offset.ts";
import { parseCommand } from "@ui-core/commands.ts";
import { PRESETS, keymapConfig } from "../keymap-config.ts";
import type { FunctionCatalogue } from "../hooks.ts";
import { back, forward, getSelection, select, type Selection } from "../state/selection.ts";
import { setThemePreset, toggleTheme as toggleThemeStore } from "../theme/store.ts";
import {
  closeDialog, getActionsState, openDialog, setOverlay, setPaletteOpen, setRightPanel, setStatus,
} from "./store.ts";
import { addTag, fnTarget } from "./writes.ts";
import { workersApi } from "../workers/wire.ts";
import { api } from "../api.ts";
import type { FnSummary } from "../contracts.ts";
import { foldActive, unfoldActive } from "../listing/fold-store.ts";
import {
  listingLineDown as moveListingLineDown, listingLineUp as moveListingLineUp,
  listingTokenLeft as moveListingTokenLeft, listingTokenRight as moveListingTokenRight,
} from "../listing/listing-nav-store.ts";
import { openDisasm } from "../panes/disasm-store.ts";
import { setStringsPrefill } from "../panes/strings-store.ts";
import { setTablesPrefill } from "../panes/tables-store.ts";
import {
  cycleGraphLod, expandGraphNode, focusGraphNode, getGraphState, originKey as graphOriginKey, rootGraph,
  setGraphFollow, targetForSelection as graphTargetFor,
} from "../graph/store.ts";

export const registry = createStandardRegistry();

// -- spec 25: the graph view's own actions ----------------------------------
//
// Registered HERE, not in `src/ui-core/actions.ts`, on purpose: the shared
// registry's `view.graph` is deliberately `when: () => false` and
// `tests/ui-core/actions.test.ts` asserts it stays that way until the graph
// spec is wired into every shell. An implementation task never inverts an
// existing test's assertion (docs/AGENT-BRIEF.md), so the browser shell adds
// its own `graph.*` ids instead and `openGraph` below is pointed at the real
// pane — flipping `view.graph` later is then a one-line core change plus
// that test's update (docs/specs/25-ui-graph-view.md §4).
function graphTarget(ctx: ActionContext): boolean {
  return graphTargetFor(ctx.selection as Selection) !== null;
}

registry.register({
  id: "graph.open",
  title: "Open graph (neighbourhood)",
  group: "view",
  when: graphTarget,
  run: (ctx) => openGraphOn(ctx.selection as Selection),
});
registry.register({
  id: "graph.focus",
  title: "Focus graph on selection",
  group: "view",
  when: graphTarget,
  run: (ctx) => {
    const t = graphTargetFor(ctx.selection as Selection);
    if (t === null) return setStatus("nothing to focus the graph on");
    focusGraphNode(t);
    setRightPanel("graph");
  },
});
registry.register({
  id: "graph.expand",
  title: "Expand in graph (one hop)",
  group: "view",
  when: (ctx) => ctx.selection.fn !== undefined && ctx.selection.fn >= 0,
  run: (ctx) => {
    const fn = ctx.selection.fn;
    if (fn === undefined || fn < 0) return setStatus("select a function to expand in the graph");
    expandGraphNode(fn);
    setRightPanel("graph");
  },
});

// -- spec 26 L8: the attended "Edit & recompile" flow ------------------------
//
// One registry entry, exactly as spec 26 §3.1 promises ("every new action in
// L4/L6/L8 is one registry entry and appears in the menu, the palette and the
// keymap for free"). It only OPENS the pane — the recompile itself needs a
// second, explicit confirmation inside `EditPane.tsx`, because it is the one
// operation that produces a modified binary (spec 17 §13). Deliberately no
// `defaultChord`: a keystroke away is too close for this one.
registry.register({
  id: "edit.recompile",
  title: "Edit & recompile (attended)",
  group: "review",
  when: (ctx) => ctx.selection.fn !== undefined && ctx.selection.fn >= 0,
  run: (ctx) => {
    if (ctx.selection.fn === undefined || ctx.selection.fn < 0) return setStatus("select a function to edit and recompile");
    setRightPanel("edit");
  },
});

/** Root the graph pane on `sel` and bring the tab up. */
function openGraphOn(sel: Selection): void {
  const t = graphTargetFor(sel);
  if (t === null) return setStatus("select a function or a module to graph");
  rootGraph(t, graphOriginKey(t));
  setRightPanel("graph");
}

// -- the live keymap --------------------------------------------------------
//
// `ui/keymap.json` is the BASE (`{preset, overrides}`); the Settings dialog's
// key-binding editor layers a user config on top of it, persisted in
// localStorage exactly the way the theme preset/density are. Resolution goes
// through the one shared resolver (`@ui-core/keymap-resolve.ts`) for both, so
// the file, the dialog and the running keymap can never disagree.
//
// `keymap` below is a STABLE proxy: TopBar, RightPane, the palette and the
// context menu all imported the object directly, and a rebind must not leave
// them holding a dead one.

const PRESET_STORAGE_KEY = "hbc2js.keymap.preset";
const OVERRIDES_STORAGE_KEY = "hbc2js.keymap.overrides";

/** `ui/keymap.json` — what "reset all to preset" goes back to. */
export const baseKeymapConfig: KeymapConfig = keymapConfig;

function readStored(): KeymapConfig {
  const base: KeymapConfig = { preset: keymapConfig.preset, overrides: { ...(keymapConfig.overrides ?? {}) } };
  try {
    const preset = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (preset !== null && PRESETS[preset] !== undefined) base.preset = preset;
    const raw = window.localStorage.getItem(OVERRIDES_STORAGE_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        base.overrides = { ...base.overrides, ...(parsed as Record<string, string | null>) };
      }
    }
  } catch {
    // private-browsing / corrupt value: fall back to ui/keymap.json.
  }
  return base;
}

function build(cfg: KeymapConfig): Keymap {
  return createKeymap(resolveKeymapConfigWith(cfg, registry, PRESETS));
}

function safeConfig(): KeymapConfig {
  const stored = readStored();
  try {
    build(stored);
    return stored;
  } catch {
    return { preset: keymapConfig.preset, overrides: { ...(keymapConfig.overrides ?? {}) } };
  }
}

let config: KeymapConfig = safeConfig();
let active: Keymap = build(config);

const keymapListeners = new Set<() => void>();

/** The active keymap: `ui/keymap.json`'s preset plus its overrides and the
 *  user's own rebinds, validated against `registry` (an override naming an
 *  unknown action id throws at resolve time, not silently at keypress). */
export const keymap: Keymap = {
  feed: (event, now) => (now === undefined ? active.feed(event) : active.feed(event, now)),
  reset: () => active.reset(),
  isPending: () => active.isPending(),
  chordFor: (id) => active.chordFor(id),
};

export function getKeymapConfig(): KeymapConfig {
  return config;
}

/** chord -> action id, preset + overrides flattened: what the cheat-sheet,
 *  the settings editor and the conflict check all read. */
export function activeBindings(): Record<string, string> {
  return mergeBindings(PRESETS[config.preset] ?? {}, config.overrides ?? {});
}

function persist(cfg: KeymapConfig): void {
  try {
    window.localStorage.setItem(PRESET_STORAGE_KEY, cfg.preset);
    window.localStorage.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(cfg.overrides ?? {}));
  } catch {
    // best-effort, like every other localStorage use in the shell.
  }
}

/** Applies a new keymap config live (no reload) and persists it. Throws,
 *  without changing anything, when the config does not resolve. */
export function setKeymapConfig(next: KeymapConfig): void {
  const built = build(next);
  config = next;
  active = built;
  persist(next);
  for (const l of [...keymapListeners]) l();
}

/** Back to `ui/keymap.json` — drops every in-app rebind. */
export function resetKeymapConfig(): void {
  setKeymapConfig({ preset: keymapConfig.preset, overrides: { ...(keymapConfig.overrides ?? {}) } });
}

function subscribeKeymap(l: () => void): () => void {
  keymapListeners.add(l);
  return () => {
    keymapListeners.delete(l);
  };
}

/** React view of the live config — every chord label re-renders on a rebind. */
export function useKeymapConfig(): KeymapConfig {
  return useSyncExternalStore(subscribeKeymap, getKeymapConfig, getKeymapConfig);
}

// -- query client -----------------------------------------------------------

let queryClient: QueryClient | null = null;

/** ActionsProvider hands us the app's QueryClient so writes can invalidate
 *  and `next/prev function` can walk the cached catalogue. */
export function setQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

/** Everything a write to `fn` invalidates: its summary, its rendered source
 *  and disasm, its context/xrefs, the catalogue the tree renders from, the
 *  findings list and the log tail (so the write shows up in the log pane).
 *  Also drops the owning module's whole-file view (`["module-source", id]`,
 *  `useModuleSource`/`useModuleSourceUpdates` in `hooks.ts`) — the server
 *  now splices accepted `reg:F:R` renders into that view too, so a rename
 *  must refetch it the same way it refetches `source` (docs/UI.md, "Still
 *  rough here" used to note the module view never picked renames up). The
 *  module id comes from the already-cached function catalogue, never a
 *  fresh request. */
export function invalidateFn(fn: number | undefined): void {
  const qc = queryClient;
  if (qc === null) return;
  const keys = ["fn", "source", "disasm", "context", "who-calls", "calls-from", "locals"] as const;
  if (fn !== undefined) {
    for (const k of keys) void qc.invalidateQueries({ queryKey: [k, fn] });
    const module = catalogue()?.rows.find((r) => r.fn === fn)?.module;
    if (module !== null && module !== undefined) void qc.invalidateQueries({ queryKey: ["module-source", module] });
  }
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

/** Bur 5 (docs/UI-BURS.md #5): executes a ":"-mode CommandPalette query.
 *  `query` may include or omit the leading ":" (`src/ui-core/commands.ts`
 *  strips it). The catalogue/theme/keymap lookups all live here because this
 *  is the one place that already has the query client, the theme store and
 *  the keymap store in scope — `commands.ts` stays a pure parser. */
export function runCommand(query: string): void {
  const cmd = parseCommand(query);
  switch (cmd.kind) {
    case "fn": {
      const rows = catalogue()?.rows ?? [];
      if (!rows.some((r) => r.fn === cmd.n)) return setStatus(`no such function: fn ${cmd.n}`);
      select({ kind: "fn", fn: cmd.n });
      return;
    }
    case "mod": {
      const rows = catalogue()?.rows ?? [];
      const first = rows.find((r) => r.module === cmd.id);
      if (first === undefined) return setStatus(`no such module: ${cmd.id}`);
      select({ kind: "fn", fn: first.fn });
      return;
    }
    case "goto": {
      const rows = catalogue()?.rows ?? [];
      const needle = cmd.name.toLowerCase();
      const hit = rows.find((r) => (r.name ?? "").toLowerCase().includes(needle));
      if (hit === undefined) return setStatus(`no function found matching "${cmd.name}"`);
      select({ kind: "fn", fn: hit.fn });
      return;
    }
    case "quit": {
      const s = getActionsState();
      if (s.dialog.kind !== "none") return closeDialog();
      if (s.overlay !== "none") return setOverlay("none");
      setRightPanel("context");
      return;
    }
    case "set": {
      try {
        if (cmd.what === "theme") setThemePreset(cmd.value);
        else setKeymapConfig({ preset: cmd.value, overrides: getKeymapConfig().overrides ?? {} });
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    case "action": {
      if (cmd.query === "") return;
      // `runAction` already reports a "not available" status when the id is
      // real but gated off by `when()` — only add a message for a query
      // that never matched a real action id at all.
      if (registry.get(cmd.query) === undefined) return setStatus(`no action "${cmd.query}"`);
      runAction(cmd.query);
    }
  }
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

/** spec 23 §6: the two AI actions enqueue a job on the server-owned pool and
 *  report what happened; the result appears in the right pane's AI tab (the
 *  jobs rail, then the suggestion with Accept/Reject). Nothing here writes to
 *  the project — a proposal is not truth until a human promotes it. */
async function queueJob(kind: "explain-fn" | "suggest-name", target: CoreSelection): Promise<void> {
  if (target.fn === undefined) return setStatus("select a function first");
  setRightPanel("workers");
  try {
    const res = await workersApi.enqueue(kind, { fn: target.fn });
    queryClient?.invalidateQueries({ queryKey: ["jobs"] });
    setStatus(res.deduped ? `${kind} for fn:${target.fn} is already queued` : `${kind} queued for fn:${target.fn}`);
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

/** `view.copyDisasmOffset` (docs/UI.md) — copies the function's real disasm
 *  offset, `fn:<n>@0x<hex>` (`FnSummary.offset`, `@ui-core/disasm-offset.ts`
 *  does the formatting). Reads `useFn`'s own cache (`["fn", fn]`, same key
 *  `invalidateFn` drops) first so an already-open function pane copies with
 *  no extra request; only fetches when nothing is cached yet. */
async function copyDisasmOffset(fn: number): Promise<void> {
  const cached = queryClient?.getQueryData<FnSummary>(["fn", fn]);
  const summary = cached ?? (await api.fn(fn).catch(() => undefined));
  copy(formatDisasmOffset(fn, summary?.offset));
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
  showStrings: (target) => {
    if (target.kind === "string" && target.name !== undefined) setStringsPrefill(target.name);
    setRightPanel("strings");
  },
  showTables: (target) => {
    if (target.kind === "string" && target.name !== undefined) setTablesPrefill(target.name);
    setRightPanel("tables");
  },
  search: () => focusSearch(),
  openPalette: () => setPaletteOpen(true),
  openCommandMode: () => setPaletteOpen(true, "command"),
  toggleTheme: () => toggleThemeStore(),
  openShortcuts: () => setOverlay("shortcuts"),
  openSettings: () => setOverlay("settings"),
  markReviewed: (target) => tag(target, "reviewed"),
  markSuspicious: (target) => tag(target, "suspicious"),
  copyDisasmOffset: (target) => (target.fn === undefined ? copy("") : copyDisasmOffset(target.fn)),
  showRawHermes: () => {
    openDisasm();
    setStatus("showing disasm");
  },
  explain: (target) => queueJob("explain-fn", target),
  suggestName: (target) => queueJob("suggest-name", target),
  // spec 25: the shared registry's `view.graph` is still gated off, but
  // its binding is real now — see the `graph.*` registrations above.
  openGraph: (target) => openGraphOn(target as Selection),
  // Burs 9/10 (spec 25 §5a/§5b). Both raise the Graph tab first: a toggle
  // the analyst cannot see the effect of would be a silent action.
  toggleGraphFollow: () => {
    const next = !getGraphState().follow;
    setGraphFollow(next);
    setRightPanel("graph");
    setStatus(next ? "graph: following the selection" : "graph: not following the selection");
  },
  cycleGraphLod: () => {
    const level = cycleGraphLod();
    setRightPanel("graph");
    setStatus(`graph: ${level} level`);
  },
  nextFn: () => stepFn(1),
  prevFn: () => stepFn(-1),
  nextModule: () => stepModule(1),
  prevModule: () => stepModule(-1),
  back: () => void back(),
  forward: () => void forward(),
  fold: () => setStatus(foldActive() ? "folded" : "no listing to fold"),
  unfold: () => setStatus(unfoldActive() ? "unfolded" : "no listing to unfold"),
  // Bur 13: arrow-key navigation in the listing. `listingLineDown`/Up and
  // `listingTokenLeft`/Right (../listing/listing-nav-store.ts) resolve the
  // move through the SAME token/line hit-testing a click uses, then report
  // it through the pane's own `onSelectToken` callback — so it calls
  // `select()` exactly like a click did, which is what makes the graph
  // follow toggle and the jump list track it "like a click would" for free.
  listingLineDown: () => {
    if (!moveListingLineDown()) setStatus("no listing on screen, or already at the last line");
  },
  listingLineUp: () => {
    if (!moveListingLineUp()) setStatus("no listing on screen, or already at the first line");
  },
  listingTokenLeft: () => {
    if (!moveListingTokenLeft()) setStatus("no listing on screen, or already at the first token on this line");
  },
  listingTokenRight: () => {
    if (!moveListingTokenRight()) setStatus("no listing on screen, or already at the last token on this line");
  },
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
