// ui/src/listing/search-store.ts — the top bar's query, shared with the left
// pane's filter. A module-level store rather than App state so the top bar
// and the tree can talk without either owning the other (App.tsx is shared
// with two other wave-2 tracks; every prop added there is a merge conflict).
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let query = "";

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getQuery(): string {
  return query;
}

export function setQuery(next: string): void {
  if (next === query) return;
  query = next;
  emit();
}

export function useQueryText(): string {
  return useSyncExternalStore(subscribe, getQuery, getQuery);
}
