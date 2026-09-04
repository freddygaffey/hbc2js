// ui/src/panes/strings-store.ts — the query the Strings tab's search box
// shows when `navigate.strings` opens it from a clicked string literal
// (spec 22 §3). Same useSyncExternalStore pattern as
// ui/src/listing/search-store.ts: a module-level store, not App state, so
// ui/src/actions/registry.ts (outside React) can set it without threading a
// prop through App.tsx (shared with two other wave-2 tracks).
import { useSyncExternalStore } from "react";

export interface StringsPrefill {
  readonly text: string;
  /** Bumped on every `setStringsPrefill` call so StringsPane's effect fires
   *  even when the same string is clicked twice in a row. */
  readonly seq: number;
}

const listeners = new Set<() => void>();
let state: StringsPrefill = { text: "", seq: 0 };

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): StringsPrefill {
  return state;
}

export function setStringsPrefill(text: string): void {
  state = { text, seq: state.seq + 1 };
  emit();
}

export function useStringsPrefill(): StringsPrefill {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
