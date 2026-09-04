// ui/src/listing/names.ts — one answer to "what is this function called?".
//
// Three sources disagree on purpose (spec 16/17): `/api/fn/{fn}` reports the
// bytecode `name` and the overlay's `overlayName`, while an *accepted*
// rename surfaces only as `metadata.acceptedName` on `/api/fn/{fn}/context`.
// The UI must show the accepted name wherever a function is named, or a
// rename looks like it did nothing. Precedence, most human first:
// acceptedName > overlayName > name > `fn N`.
//
// The annotate track has a single-source variant of this in
// ui/src/actions/names.ts (`displayName(md)`, returns null when it knows
// nothing). This one takes SEVERAL sources because the listing has two —
// `/api/fn/{fn}` and the richer `/api/fn/{fn}/context` metadata — and must
// prefer whichever of them actually carries the accepted name, and because
// a pane always has to render something. The precedence order is the same
// in both; if it ever changes, change it in both.

export interface NamedFn {
  readonly name?: string | null;
  readonly overlayName?: string | null;
  readonly acceptedName?: string | null;
}

function firstReal(...values: readonly (string | null | undefined)[]): string | null {
  for (const v of values) if (v !== null && v !== undefined && v !== "") return v;
  return null;
}

/** The name to show, given any number of (possibly stale/absent) sources. */
export function displayName(fn: number, ...sources: readonly (NamedFn | null | undefined)[]): string {
  for (const key of ["acceptedName", "overlayName", "name"] as const) {
    const hit = firstReal(...sources.map((s) => s?.[key] ?? null));
    if (hit !== null) return hit;
  }
  return `fn ${fn}`;
}
