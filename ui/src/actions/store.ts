// ui/src/actions/store.ts — the small pieces of shell state the ACTIONS own
// (spec 22 §3.1): which modal an action opened, whether the palette is up,
// which right-hand panel `navigate.xrefs` switched to, and the one-line
// status/toast a write leaves behind. Same `useSyncExternalStore` pattern as
// ui/src/state/selection.ts, and for the same reason: keymap handlers and the
// context menu run OUTSIDE React and must be able to set it.
import { useSyncExternalStore } from "react";
import type { Selection } from "../state/selection.ts";

export type DialogKind = "none" | "rename" | "comment" | "finding";

export interface DialogState {
  readonly kind: DialogKind;
  /** The selection the action was invoked on, frozen at open time. */
  readonly selection: Selection;
}

/** The two shell-wide overlays the project actions open (spec 22 §3.1):
 *  the keyboard cheat-sheet and the Settings dialog. */
export type Overlay = "none" | "shortcuts" | "settings";

export type RightPanel = "context" | "xrefs" | "strings" | "tables" | "graph" | "findings" | "package" | "workers";

/** Bur 5 (docs/UI-BURS.md #5): "command" is the vim-style ":" mode —
 *  CommandPalette prefills its query with ":" and interprets it as
 *  `src/ui-core/commands.ts` describes, instead of the plain action list. */
export type PaletteMode = "normal" | "command";

/** spec 26 L10 (ii): docking two right panels at once — the vertical stack
 *  in `RightPane.tsx` shows `rightPanel` (top/primary) always, and
 *  `rightPanel2` (bottom/secondary) when it is not `null`. */
export interface Layout {
  readonly rightPanel: RightPanel;
  readonly rightPanel2: RightPanel | null;
}

export interface ActionsState {
  readonly dialog: DialogState;
  readonly paletteOpen: boolean;
  readonly paletteMode: PaletteMode;
  readonly overlay: Overlay;
  readonly rightPanel: RightPanel;
  /** `null` = single-panel layout (the fallback default, §4.4). */
  readonly rightPanel2: RightPanel | null;
  /** Last write result / hint, shown in the status toast. `null` = nothing. */
  readonly status: string | null;
  /** The chord keys typed so far while a multi-key sequence is pending. */
  readonly pendingChord: string;
}

const CLOSED: DialogState = { kind: "none", selection: { kind: "none" } };

/** First-run default (§4.4 "everything else is mechanical" — Fred did not
 *  name a hierarchy, so the fallback the spec names is used verbatim: the
 *  pre-L10 single-panel layout). */
export const DEFAULT_LAYOUT: Layout = { rightPanel: "context", rightPanel2: null };

const LAYOUT_KEY = "hbc2js.layout.current";
const LAYOUTS_KEY = "hbc2js.layout.named";

/** Same try/catch idiom as ui/src/graph/store.ts's `readFollow`: a
 *  private-browsing tab, a `window`-less test run (no `typeof` guard
 *  needed — referencing `window` itself throws, and the catch below is
 *  exactly what catches that) or corrupt JSON all degrade to `fallback`. */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort persistence only.
  }
}

function readCurrentLayout(): Layout {
  const saved = readJson<Partial<Layout>>(LAYOUT_KEY, {});
  return {
    rightPanel: saved.rightPanel ?? DEFAULT_LAYOUT.rightPanel,
    rightPanel2: saved.rightPanel2 ?? DEFAULT_LAYOUT.rightPanel2,
  };
}

function writeCurrentLayout(layout: Layout): void {
  writeJson(LAYOUT_KEY, layout);
}

/** Named saved layouts (§(iii)): a plain name -> `Layout` map, persisted
 *  like the current layout. Unbounded (there is no jump-list-style cap
 *  here — an analyst naming layouts is not going to name a hundred). */
function readNamedLayouts(): Readonly<Record<string, Layout>> {
  return readJson<Record<string, Layout>>(LAYOUTS_KEY, {});
}

function writeNamedLayouts(layouts: Readonly<Record<string, Layout>>): void {
  writeJson(LAYOUTS_KEY, layouts);
}

const persistedLayout = readCurrentLayout();

const INITIAL: ActionsState = {
  dialog: CLOSED,
  paletteOpen: false,
  paletteMode: "normal",
  overlay: "none",
  rightPanel: persistedLayout.rightPanel,
  rightPanel2: persistedLayout.rightPanel2,
  status: null,
  pendingChord: "",
};

let state: ActionsState = INITIAL;

const listeners = new Set<() => void>();

function set(patch: Partial<ActionsState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getActionsState(): ActionsState {
  return state;
}

/** ui/src/state/url.ts (spec 26 L10): the URL sync needs to know when
 *  `rightPanel` changes, from outside React, same reason every other
 *  `subscribe*` export in this shell exists. */
export { subscribe as subscribeActions };

export function useActionsState(): ActionsState {
  return useSyncExternalStore(subscribe, getActionsState, getActionsState);
}

export function openDialog(kind: Exclude<DialogKind, "none">, selection: Selection): void {
  set({ dialog: { kind, selection } });
}

export function closeDialog(): void {
  set({ dialog: CLOSED });
}

/** `mode` only matters while opening (`open: true`) — it tells
 *  CommandPalette whether to prefill its query with ":" (bur 5). Closing
 *  never needs a mode, so callers may omit it. */
export function setPaletteOpen(open: boolean, mode: PaletteMode = "normal"): void {
  set(open ? { paletteOpen: true, paletteMode: mode } : { paletteOpen: false });
}

export function setOverlay(overlay: Overlay): void {
  set({ overlay });
}

export function setRightPanel(panel: RightPanel): void {
  set({ rightPanel: panel });
  writeCurrentLayout({ rightPanel: panel, rightPanel2: state.rightPanel2 });
}

/** Open (a tab name) or close (`null`) the secondary right panel — the
 *  "two right panels at once" docking spec 26 L10 (ii) asks for. Opening
 *  with the same tab already showing primary is refused (a split showing
 *  the same content twice is not useful and not what "two panels" means). */
export function setRightPanel2(panel: RightPanel | null): void {
  if (panel !== null && panel === state.rightPanel) return;
  set({ rightPanel2: panel });
  writeCurrentLayout({ rightPanel: state.rightPanel, rightPanel2: panel });
}

/** §(iii) "reset layout" action (`layout.reset`): back to the single-panel
 *  default, discarding the split. Does not touch which named layouts are
 *  saved — only the CURRENT arrangement. */
export function resetLayout(): void {
  set({ rightPanel: DEFAULT_LAYOUT.rightPanel, rightPanel2: DEFAULT_LAYOUT.rightPanel2 });
  writeCurrentLayout(DEFAULT_LAYOUT);
}

/** Save the current arrangement under `name` (overwriting any existing
 *  layout of that name). */
export function saveLayout(name: string): void {
  const layouts = { ...readNamedLayouts() };
  layouts[name] = { rightPanel: state.rightPanel, rightPanel2: state.rightPanel2 };
  writeNamedLayouts(layouts);
}

/** Switch to a previously saved named layout; a no-op if `name` was never
 *  saved (or was deleted since). */
export function loadLayout(name: string): void {
  const layout = readNamedLayouts()[name];
  if (layout === undefined) return;
  set({ rightPanel: layout.rightPanel, rightPanel2: layout.rightPanel2 });
  writeCurrentLayout(layout);
}

export function deleteLayout(name: string): void {
  const layouts = { ...readNamedLayouts() };
  delete layouts[name];
  writeNamedLayouts(layouts);
}

/** Names of every saved layout, alphabetical (stable order for a menu). */
export function listLayoutNames(): readonly string[] {
  return Object.keys(readNamedLayouts()).sort();
}

export function setStatus(status: string | null): void {
  set({ status });
}

export function setPendingChord(pendingChord: string): void {
  set({ pendingChord });
}

/** Test/dev only. */
export function resetActionsState(): void {
  state = INITIAL;
  for (const l of [...listeners]) l();
}
