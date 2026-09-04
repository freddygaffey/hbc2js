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

export type RightPanel = "context" | "xrefs" | "strings" | "findings" | "package" | "workers";

export interface ActionsState {
  readonly dialog: DialogState;
  readonly paletteOpen: boolean;
  readonly rightPanel: RightPanel;
  /** Last write result / hint, shown in the status toast. `null` = nothing. */
  readonly status: string | null;
  /** The chord keys typed so far while a multi-key sequence is pending. */
  readonly pendingChord: string;
}

const CLOSED: DialogState = { kind: "none", selection: { kind: "none" } };

let state: ActionsState = { dialog: CLOSED, paletteOpen: false, rightPanel: "context", status: null, pendingChord: "" };

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

export function setPaletteOpen(open: boolean): void {
  set({ paletteOpen: open });
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
  state = { dialog: CLOSED, paletteOpen: false, rightPanel: "context", status: null, pendingChord: "" };
  for (const l of [...listeners]) l();
}
