// ui/src/listing/fold-store.ts — the primary listing editor's live
// CodeMirror view, so `view.fold` / `view.unfold` (../actions/registry.ts)
// can fold/unfold the source CodeView without threading a React ref through
// CenterPane. CodeView (registerFold prop) is the only registrant — the
// disasm block never registers, so folding always targets the listing, per
// spec 22 §3.1's `view.fold` / `view.unfold`. Same module-level-store shape
// as ./search-store.ts.
import { foldAll, unfoldAll } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;

/** CodeView calls this on mount (with its view) and on unmount (with null). */
export function setActiveFoldView(view: EditorView | null): void {
  active = view;
}

/** For tests only. */
export function getActiveFoldView(): EditorView | null {
  return active;
}

/** Folds every foldable range in the active listing editor. Returns false
 *  (does nothing) when no listing editor is mounted. */
export function foldActive(): boolean {
  return active === null ? false : foldAll(active);
}

/** Unfolds every folded range in the active listing editor. Returns false
 *  (does nothing) when no listing editor is mounted. */
export function unfoldActive(): boolean {
  return active === null ? false : unfoldAll(active);
}
