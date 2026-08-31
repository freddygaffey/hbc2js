// fn-naming writer — docs/specs/passes/05-fn-naming.md §5.
//
// Pure alpha-renaming: each renamed `func` statement's `name` becomes its
// `to`, and every `{k:"ident", name: from}` anywhere reachable from the list
// — including inside nested `func` bodies, which is where a recursive
// self-reference lives — becomes `{k:"ident", name: to}`. Nothing else
// changes: no statement is added, removed, or reordered. `mapStmts`/
// `mapExpr` already recurse into a nested `func`'s own body (both for its
// statements and its expressions), so one bottom-up rebuild handles every
// statement-name rename and every reference in the same pass — for all of
// the site's renames at once (§4 "batched"; one rebuild, not one per name).
import type { Expr, Stmt } from "../ast.ts";
import { mapStmts } from "../ast.ts";
import type { FnNamingMatch } from "./match.ts";

/** Renames every occurrence of each key of `mapping` to its value — the
 *  `func` statement's own name (root-level or nested) and every
 *  `ident`/`func` expression reference — anywhere reachable from `list`, in
 *  one rebuild. Exported so `check.ts`'s obligation 3 ("printing `after` with
 *  the renames undone is byte-identical to printing `before`") can call it
 *  with the inverse mapping, per spec §6. */
export function renameIdents(list: readonly Stmt[], mapping: ReadonlyMap<string, string>): readonly Stmt[] {
  const renameExpr = (e: Expr): Expr => {
    if (e.k === "ident") {
      const to = mapping.get(e.name);
      return to === undefined ? e : { ...e, name: to };
    }
    if (e.k === "func" && e.name !== null) {
      const to = mapping.get(e.name);
      return to === undefined ? e : { ...e, name: to };
    }
    return e;
  };
  const renameStmt = (s: Stmt): Stmt => {
    if (s.k !== "func") return s;
    const to = mapping.get(s.name);
    return to === undefined ? s : { ...s, name: to };
  };
  return mapStmts(list, renameStmt, renameExpr);
}

/** The single-pair form, kept for unit tests and for readers of spec §6's
 *  literal `renameIdent(after, to, from)`. */
export function renameIdent(list: readonly Stmt[], from: string, to: string): readonly Stmt[] {
  return renameIdents(list, new Map([[from, to]]));
}

export function rewrite(m: FnNamingMatch): readonly Stmt[] {
  return renameIdents(m.root, new Map(m.data.renames.map((r) => [r.from, r.to])));
}
