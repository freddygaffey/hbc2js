// ui/src/listing/truncate.ts — the listing's own render cap. `/api/fn/:fn/
// source` already truncates server-side and says so (`SourceText.truncated`,
// `totalLines`); this is the SECOND cap, in the browser, because a 200 000
// line generated module still kills a DOM even after the server cut it.
// Spec 22 §2 accepts no virtualisation for the MVP; a hard line cap plus an
// honest bar is the substitute.

/** Never render more than this many lines in one editor. */
export const MAX_RENDER_LINES = 5000;

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
