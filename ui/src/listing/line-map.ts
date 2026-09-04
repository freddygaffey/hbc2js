// ui/src/listing/line-map.ts — source <-> disasm alignment (docs/specs/
// 05-emitter.md §16, docs/UI.md "Source<->disasm alignment").
//
// Pure functions, no React and no CodeMirror, so the root gate can import them
// with no `ui/node_modules` present (tests/gate/ui/line-map-align.test.ts).
//
// The server's map is honest-partial: only lines a statement with a recorded
// bytecode origin printed on appear in it. This module never invents a row —
// the worst it does is fall back to the nearest EARLIER mapped line, which is
// the last instruction known to precede the cursor, and says so by returning
// that row rather than the requested line.
import type { LineMapEntry } from "../contracts.ts";

/** Convert a line the editor reports into the function's own 1-based
 *  numbering. In the whole-file view the editor counts from the top of the
 *  module file, and `fnStartLine` is where the function's text begins there
 *  (`ArtifactService.lineMap`). `null` whenever the answer would be a guess. */
export function fnLocalLine(editorLine: number | null, fileView: boolean, fnStartLine: number | null): number | null {
  if (editorLine === null) return null;
  if (!fileView) return editorLine;
  if (fnStartLine === null) return null;
  const local = editorLine - fnStartLine + 1;
  return local >= 1 ? local : null;
}

/** The map row governing `localLine`: an exact hit, else the nearest mapped
 *  line above it. Rows for OTHER functions (a nested closure printed inside
 *  this one, §16.1) are ignored — their offsets index a different listing. */
export function rowForLine(rows: readonly LineMapEntry[], fn: number, localLine: number | null): LineMapEntry | null {
  if (localLine === null) return null;
  let best: LineMapEntry | null = null;
  for (const row of rows) {
    if (row[1] !== fn) continue;
    if (row[0] > localLine) break; // rows arrive sorted by line
    best = row;
  }
  return best;
}

/** `rowForLineAcrossFns`'s result: the row it picked, the `fn` that row
 *  belongs to, and whether that `fn` differs from the one the caller asked
 *  about (a nested closure printed inline, §16.2). */
export interface RowAcrossFns {
  readonly row: LineMapEntry;
  readonly fn: number;
  readonly nested: boolean;
}

/** Like `rowForLine`, but not confined to `fn`: the last row at or before
 *  `localLine` in the WHOLE array, whichever function it belongs to. §16.2's
 *  inline-function mapping interleaves a nested closure's own rows into its
 *  enclosing function's map (same array, sorted by line together), so the
 *  nearest preceding row overall is the honest answer to "what produced this
 *  line" even when it is not `fn`'s own row: the cursor is sitting inside
 *  that closure's body as printed, not the enclosing function's. When the
 *  picked row's `fn` equals the one asked about, `nested` is `false` and the
 *  result is the same row `rowForLine` would have picked; otherwise
 *  `nested: true` and `fn: row[1]` names the closure whose disassembly should
 *  actually be shown.
 *
 *  One known imprecision (§16.2): an inline closure's closing `}`/`);` line
 *  is shared with the statement that encloses it (no origin is recorded for
 *  either), so the LAST printed line of a nested closure's body can resolve
 *  to a row that still belongs to the child even though the cursor sitting
 *  there reads, to a human, as back in the parent. This module does not try
 *  to disambiguate it — that would be a guess — and a test pins it as
 *  documented, accepted behaviour rather than a bug. */
export function rowForLineAcrossFns(rows: readonly LineMapEntry[], fn: number, localLine: number | null): RowAcrossFns | null {
  if (localLine === null) return null;
  let best: LineMapEntry | null = null;
  for (const row of rows) {
    if (row[0] > localLine) break; // rows arrive sorted by line
    best = row;
  }
  if (best === null) return null;
  return { row: best, fn: best[1], nested: best[1] !== fn };
}

/** The 1-based line of `text` that disassembles the instruction at `offset`.
 *  `src/disasm/print.ts` writes every instruction as `[@ <offset>] Opcode …`,
 *  so this is an anchored match, not a search. `null` when the listing does
 *  not contain it (truncated, or a different function). */
export function disasmLineForOffset(text: string, offset: number): number | null {
  const needle = `[@ ${offset}]`;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i]!.trimStart().startsWith(needle)) return i + 1;
  return null;
}

/** The whole chain: which disassembly line to highlight for the cursor line
 *  the listing reports. `null` means "nothing honest to point at" — the
 *  disassembly pane then simply keeps its own scroll position. */
export function alignedDisasmLine(
  args: {
    readonly rows: readonly LineMapEntry[];
    readonly fn: number;
    readonly editorLine: number | null;
    readonly fileView: boolean;
    readonly fnStartLine: number | null;
    readonly disasmText: string;
  },
): number | null {
  const row = rowForLine(args.rows, args.fn, fnLocalLine(args.editorLine, args.fileView, args.fnStartLine));
  return row === null ? null : disasmLineForOffset(args.disasmText, row[2]);
}
