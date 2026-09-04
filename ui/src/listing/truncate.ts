// ui/src/listing/truncate.ts — the listing's own render cap. `/api/fn/:fn/
// source` already truncates server-side and says so (`SourceText.truncated`,
// `totalLines`); this is the SECOND cap, in the browser.
//
// Fred's instruction (2026-09-04, verbatim): "file view must show the whole
// module". Measured on the fixture project's largest module (`module_226`,
// 29,754 lines, `ui/e2e/`'s throwaway rn-template fixture — Service NSW's
// own module_107, 38,173 lines, is the real-world case this exists for):
// CodeMirror 6 already virtualises the viewport (only `.cm-line`s actually
// on screen are ever mounted — ~36 of them at a time regardless of document
// size) so the SECOND cap was pure overhead for the module view, not a
// safety measure. Before vs after lifting it, same fixture module, same
// machine (`ui/e2e/`'s throwaway ui-server + `vite preview`, ports
// 7341/7342): DOM nodes under `.cm-content` 751 → 750, `.cm-line` count
// 36 → 36, paint ~399ms → ~373ms — i.e. no measurable cost; a mid-size
// module (`module_307`, 5,972 lines, just over the old cap) shows the same
// 36 `.cm-line`s / 306 DOM nodes / ~376ms after the fix, confirming the
// render cost tracks the viewport, not the document. `MAX_RENDER_LINES_MODULE`
// is a high safety ceiling (not a target — CM6 doesn't need one), kept so a
// pathological multi-million-line module still gets the honest truncation
// bar instead of hanging the tab; `MAX_RENDER_LINES` (the per-function cap)
// is untouched — the function view was never the problem (`SOURCE_LINE_CAP`
// in `src/mcp/resources.ts` already caps a single function's source at 400
// lines server-side).

/** Never render more than this many lines in the per-FUNCTION editor. */
export const MAX_RENDER_LINES = 5000;

/** Never render more than this many lines in the whole-MODULE editor
 *  (`CenterPane`'s file view). High enough that no real module hits it —
 *  it exists only so a pathological generated file doesn't hang the tab. */
export const MAX_RENDER_LINES_MODULE = 200_000;

export interface Clamped {
  readonly text: string;
  /** Lines actually handed to CodeMirror. */
  readonly shown: number;
  /** Lines the *server* said the function has (may exceed `text`'s own). */
  readonly total: number;
  /** True when anything at all is missing — server-side or here. */
  readonly truncated: boolean;
  /** How many lines are not on screen, or null when the count is unknown. */
  readonly hidden: number | null;
}

/** Clamp `text` to `max` lines and reconcile with the server's own verdict. */
export function clampLines(
  text: string,
  serverTotal: number,
  serverTruncated: boolean,
  max: number = MAX_RENDER_LINES,
): Clamped {
  const lines = text.length === 0 ? [] : text.split("\n");
  const shown = Math.min(lines.length, max);
  const clampedHere = lines.length > max;
  const total = Math.max(serverTotal, lines.length);
  const truncated = clampedHere || serverTruncated;
  return {
    text: clampedHere ? lines.slice(0, max).join("\n") : text,
    shown,
    total,
    truncated,
    hidden: truncated ? Math.max(total - shown, 0) : null,
  };
}
