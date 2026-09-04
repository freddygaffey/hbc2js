// src/ui-core/disasm-offset.ts — docs/UI.md "view.copyDisasmOffset": what
// gets put on the clipboard when the reader asks to copy a function's
// disasm offset. `FnSummary.offset` (`src/artifact/service.ts`) is the
// function header's real byte offset into the `.hbc` file (`FunctionRow.
// offset`, §2.1 of docs/specs/10-artifact-format.md — recorded by every
// build path already, this UI round only exposes it). Pure and
// dependency-free so it's tested here rather than through the browser.

/** `fn:<n>@0x<hex>` when a real byte offset is known, `fn:<n>` otherwise
 *  (no `FnSummary` fetched yet, or a caller with no offset field at all —
 *  never throws on a stale/partial cache read). `offset` is truncated with
 *  `Math.trunc` and treated as absent if negative or non-finite: a
 *  malformed offset must fall back to the old `fn:<n>` shape, not lie. */
export function formatDisasmOffset(fn: number, offset: number | null | undefined): string {
  if (offset === null || offset === undefined || !Number.isFinite(offset) || offset < 0) return `fn:${fn}`;
  return `fn:${fn}@0x${Math.trunc(offset).toString(16)}`;
}
