// src/ui-core/rename-target.ts — which binding a Rename actually renames.
//
// The source pane's selection is a TOKEN (`ui/src/panes/CenterPane.tsx`'s
// `{kind:"identifier", fn, name, line}`); the project's rename target is a
// binding id (`src/name-overlay/id.ts`: `reg:<fn>:<reg>` for a local,
// `fn:<n>` for the function itself). The join is `GET /api/fn/{fn}/locals`,
// whose `rendered` column is the identifier as it appears in the served
// source — so a click on `r3` (passes-off) or on `count` (already renamed,
// or var-named) both resolve to the register they came from.
//
// Pure and dependency-free so it is tested in `tests/ui-core/` rather than
// through the browser; the dialog only formats what this returns.

/** One row of `GET /api/fn/{fn}/locals` (`McpResources.locals`). */
export interface LocalBinding {
  readonly reg: number;
  readonly rendered: string;
  readonly named: string | null;
  readonly role: string;
  readonly uses: number;
}

export interface RenameTarget {
  /** The `set_name` target string. */
  readonly target: string;
  readonly kind: "reg" | "fn";
  /** The register, when `kind` is `"reg"`. */
  readonly reg?: number;
  /** The clicked token, `""` when the selection carried none. */
  readonly token: string;
  /** How many idents the rename re-labels (`uses`), 0 when unknown. */
  readonly uses: number;
  /** Set when a token WAS clicked but maps to no nameable register: the
   *  dialog says so rather than silently renaming the enclosing function
   *  (docs/UI.md "Still rough here" used to describe that silent fallback). */
  readonly fellBack: boolean;
}

/** Resolve the clicked token against this function's nameable registers.
 *  Matches the rendered identifier first (that IS what the reader clicked),
 *  then the accepted name, so a stale listing still resolves. Anything else
 *  — no token, no listing yet, a property/keyword/string token — targets the
 *  enclosing function, exactly as before. */
export function renameTargetFor(fn: number, token: string | undefined, locals: readonly LocalBinding[] | undefined): RenameTarget {
  const t = (token ?? "").trim();
  if (t !== "" && locals !== undefined && locals.length > 0) {
    const hit = locals.find((l) => l.rendered === t) ?? locals.find((l) => l.named === t);
    if (hit !== undefined) return { target: `reg:${fn}:${hit.reg}`, kind: "reg", reg: hit.reg, token: t, uses: hit.uses, fellBack: false };
  }
  return { target: `fn:${fn}`, kind: "fn", token: t, uses: 0, fellBack: t !== "" };
}
