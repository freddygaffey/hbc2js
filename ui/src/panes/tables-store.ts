// ui/src/panes/tables-store.ts — same useSyncExternalStore pattern as
// ui/src/panes/strings-store.ts: `navigate.tables`, called on a `"string"`
// selection (a clicked string literal), pre-fills the Tables tab's value
// filter with that string so "does this literal appear in a constant
// table?" is one chord away, the same way `navigate.strings` pre-fills the
// Strings tab's search from the same kind of selection. A module-level
// store, not App state, so `src/ui-core/actions.ts`'s registry (outside
// React) can set it without threading a prop through App.tsx.
import { useSyncExternalStore } from "react";

export interface TablesPrefill {
  readonly value: string;
  /** Bumped on every `setTablesPrefill` call so TablesPane's effect fires
   *  even when the same value is clicked twice in a row. */
  readonly seq: number;
}

const listeners = new Set<() => void>();
let state: TablesPrefill = { value: "", seq: 0 };

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): TablesPrefill {
  return state;
}

export function setTablesPrefill(value: string): void {
  state = { value, seq: state.seq + 1 };
  emit();
}

export function useTablesPrefill(): TablesPrefill {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
