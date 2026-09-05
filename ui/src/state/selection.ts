// ui/src/state/selection.ts — the one place the shell keeps "what is
// selected". Spec 22 §3.1: the context menu, the palette and the keymap are
// views over `src/ui-core/actions.ts`'s registry, and every action reads
// `ActionContext.selection`. So this store's `Selection` is a FIELD-FOR-FIELD
// structural copy of `Selection` in `src/ui-core/actions.ts` (ui/ is a
// separate package and must not import from the root `src/` tree — same rule
// as ui/src/contracts.ts). If the two disagree, `src/ui-core` wins.
//
// Extra beyond the registry's shape: `line`, the 1-based listing line the
// selection came from. The registry ignores unknown fields, so carrying it
// here costs nothing and lets the centre pane highlight and scroll.
//
// No new dependencies: a module-level store + `useSyncExternalStore`. It is
// deliberately NOT React context — actions, keymap handlers and the command
// palette all need to read/write it from outside the tree.
import { useSyncExternalStore } from "react";

/** Mirrors `SelectionKind` in src/ui-core/actions.ts. */
export type SelectionKind = "none" | "fn" | "identifier" | "string" | "module" | "finding" | "lead";

/** Mirrors `Selection` in src/ui-core/actions.ts, plus `line`. */
export interface Selection {
  readonly kind: SelectionKind;
  /** Function id/index, when kind is "fn" or the selection is inside a function. */
  readonly fn?: number;
  /** Identifier/string text, when kind is "identifier" or "string". */
  readonly name?: string;
  /** String-table id, when kind is "string". */
  readonly sid?: number;
  /** Module id, when kind is "module". */
  readonly moduleId?: string;
  /** Finding/review-row id, when kind is "finding". */
  readonly rid?: number;
  /** Spec 26 L6: whether the finding's evidence resolves, when kind is "finding". */
  readonly evidenceResolved?: boolean;
  /** Spec 26 L6: a lead's sink class/evidence/detail, when kind is "lead". */
  readonly leadClass?: string;
  readonly leadEvidence?: string;
  readonly leadDetail?: string;
  /** 1-based line in the current listing the selection came from (UI only). */
  readonly line?: number;
}

export const NO_SELECTION: Selection = { kind: "none" };

/** Spec 22 §3.2's jump list is bounded; 100 is IDA's default and plenty. */
export const JUMP_LIMIT = 100;

type Listener = () => void;

const listeners = new Set<Listener>();

/** The jump list: `history[cursor]` is the current selection, always. */
let history: Selection[] = [NO_SELECTION];
let cursor = 0;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The current selection. Referentially stable between changes, which is
 *  what `useSyncExternalStore` requires of `getSnapshot`. */
export function getSelection(): Selection {
  return history[cursor]!;
}

/** True when `a` and `b` name the same thing — a re-select of the current
 *  selection must not push a duplicate jump-list entry. */
export function sameSelection(a: Selection, b: Selection): boolean {
  return (
    a.kind === b.kind && a.fn === b.fn && a.name === b.name && a.sid === b.sid &&
    a.moduleId === b.moduleId && a.rid === b.rid && a.line === b.line
  );
}

/** Select `sel`, truncating any forward history (browser-style). Capped at
 *  `JUMP_LIMIT` entries, oldest dropped first. */
export function select(sel: Selection): void {
  if (sameSelection(getSelection(), sel)) return;
  history = history.slice(0, cursor + 1);
  history.push(sel);
  if (history.length > JUMP_LIMIT) history = history.slice(history.length - JUMP_LIMIT);
  cursor = history.length - 1;
  emit();
}

/** ui/src/state/url.ts's popstate handler: restore `sel` as the CURRENT
 *  selection without growing the jump list a second time. If `sel` already
 *  names an entry we hold (the common case — a real browser back/forward
 *  landed on a selection `select()` itself pushed), the cursor just moves
 *  to it, exactly like `back()`/`forward()`. Otherwise (a hand-typed or
 *  externally-shared URL) it is treated as a fresh selection, same as
 *  `select()`. Never called by application code directly — only by the URL
 *  sync module. */
export function restoreSelection(sel: Selection): void {
  if (sameSelection(getSelection(), sel)) return;
  const idx = history.findIndex((h) => sameSelection(h, sel));
  if (idx >= 0) {
    cursor = idx;
  } else {
    history = history.slice(0, cursor + 1);
    history.push(sel);
    if (history.length > JUMP_LIMIT) history = history.slice(history.length - JUMP_LIMIT);
    cursor = history.length - 1;
  }
  emit();
}

export function canBack(): boolean {
  return cursor > 0;
}

export function canForward(): boolean {
  return cursor < history.length - 1;
}

/** Step back in the jump list; returns the selection now current. */
export function back(): Selection {
  if (canBack()) {
    cursor -= 1;
    emit();
  }
  return getSelection();
}

/** Step forward in the jump list; returns the selection now current. */
export function forward(): Selection {
  if (canForward()) {
    cursor += 1;
    emit();
  }
  return getSelection();
}

/** Read-only view of the jump list, oldest first, and where we are in it. */
export function jumpList(): { readonly entries: readonly Selection[]; readonly cursor: number } {
  return { entries: history, cursor };
}

/** Test/dev only: forget everything. Never called by the shell. */
export function resetSelection(): void {
  history = [NO_SELECTION];
  cursor = 0;
  emit();
}

// -- React binding ----------------------------------------------------------

/** Subscribe a component to the current selection. */
export function useSelection(): Selection {
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

/** Subscribe to the jump list's availability (for back/forward buttons). */
export function useJumpState(): { readonly canBack: boolean; readonly canForward: boolean } {
  const sel = useSelection();
  void sel; // re-render trigger; the flags below are read fresh each render.
  return { canBack: canBack(), canForward: canForward() };
}

/** The function the current selection is "inside", if any. `identifier` and
 *  `string` selections carry the enclosing `fn`, so this is not just
 *  `kind === "fn"`. */
export function selectedFn(sel: Selection): number | undefined {
  return sel.fn;
}

export { subscribe as subscribeSelection };
