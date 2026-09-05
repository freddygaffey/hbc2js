// ui/src/listing/listing-nav-store.ts — bur 13 (docs/UI-BURS.md #13): "arrow
// keys should move the selection down (and up) the reader". Same
// module-level-store shape as ./fold-store.ts: `CodeView` (registerFold
// prop) registers a handle for the PRIMARY listing block only — the
// disasm block never registers, so keyboard navigation always targets the
// listing, exactly like `view.fold`/`view.unfold`.
//
// The handle carries closures, not the raw `EditorView`, because the move
// logic needs `show()`/`handlers.current.select` from CodeView's own mount
// effect (the decoration + the pane callback that turns a hit into a real
// `select({kind:"identifier"|"fn"|"module", …})`) — exposing those as a
// well-typed pair of functions keeps this store CodeMirror-import-free and
// keeps ../actions/registry.ts (the ActionApi implementation) from having to
// know anything about EditorViews, tokens or decorations at all.
export interface ListingNavHandle {
  /** Moves the selection to the previous (`delta < 0`) or next (`delta > 0`)
   *  line, keeping the same column where possible. Returns false when there
   *  is no listing mounted or the move is a no-op (already at the first/last
   *  line). */
  moveLine(delta: number): boolean;
  /** Moves the selection to the previous/next token ON THE CURRENT LINE.
   *  Returns false at the first/last token of the line (no wrap) or when
   *  there is no listing mounted. */
  moveToken(delta: number): boolean;
}

let active: ListingNavHandle | null = null;

/** CodeView calls this on mount (with its handle) and on unmount (with
 *  null), exactly like `setActiveFoldView`. */
export function setActiveListingNav(handle: ListingNavHandle | null): void {
  active = handle;
}

/** For tests only. */
export function getActiveListingNav(): ListingNavHandle | null {
  return active;
}

/** Moves down a line in the active listing. Returns false (does nothing)
 *  when no listing editor is mounted, or the move did not change anything. */
export function listingLineDown(): boolean {
  return active !== null && active.moveLine(1);
}

/** Moves up a line in the active listing. */
export function listingLineUp(): boolean {
  return active !== null && active.moveLine(-1);
}

/** Moves to the previous token on the current line. */
export function listingTokenLeft(): boolean {
  return active !== null && active.moveToken(-1);
}

/** Moves to the next token on the current line. */
export function listingTokenRight(): boolean {
  return active !== null && active.moveToken(1);
}
