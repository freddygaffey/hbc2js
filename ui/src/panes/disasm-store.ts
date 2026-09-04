// ui/src/panes/disasm-store.ts — whether CenterPane's disasm panel is
// expanded. Lifted out of CenterPane's local `useState` so `view.rawHermes`
// (../actions/registry.ts) can open it from outside the component tree, the
// same reason ../listing/search-store.ts exists as a module-level store
// rather than App state.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let open = true;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getDisasmOpen(): boolean {
  return open;
}

export function setDisasmOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  emit();
}

/** `view.rawHermes`'s entry point: opens the panel (a no-op if already open,
 *  so the caller does not need to check first). */
export function openDisasm(): void {
  setDisasmOpen(true);
}

export function useDisasmOpen(): boolean {
  return useSyncExternalStore(subscribe, getDisasmOpen, getDisasmOpen);
}
