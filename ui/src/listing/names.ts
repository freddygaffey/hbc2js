// ui/src/listing/names.ts — one answer to "what is this function called?".
//
// Three sources disagree on purpose (spec 16/17): `/api/fn/{fn}` reports the
// bytecode `name` and the overlay's `overlayName`, while an *accepted*
// rename surfaces only as `metadata.acceptedName` on `/api/fn/{fn}/context`.
// The UI must show the accepted name wherever a function is named, or a
// rename looks like it did nothing. Precedence, most human first:
// acceptedName > overlayName > name > `fn N`.

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
