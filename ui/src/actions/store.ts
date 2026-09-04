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

export interface ActionsState {
  readonly dialog: DialogState;
  readonly paletteOpen: boolean;
  readonly paletteMode: PaletteMode;
  readonly overlay: Overlay;
  readonly rightPanel: RightPanel;
  /** Last write result / hint, shown in the status toast. `null` = nothing. */
  readonly status: string | null;
  /** The chord keys typed so far while a multi-key sequence is pending. */
  readonly pendingChord: string;
}

const CLOSED: DialogState = { kind: "none", selection: { kind: "none" } };

const INITIAL: ActionsState = {
  dialog: CLOSED,
  paletteOpen: false,
  paletteMode: "normal",
  overlay: "none",
  rightPanel: "context",
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
