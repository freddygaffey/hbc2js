// fn-naming writer — docs/specs/passes/05-fn-naming.md §5.
//
// Pure alpha-renaming: the `func` statement's `name` becomes `to`, and every
// `{k:"ident", name: from}` anywhere reachable from the list — including
// inside nested `func` bodies, which is where a recursive self-reference
// lives — becomes `{k:"ident", name: to}`. Nothing else changes: no
// statement is added, removed, or reordered. `mapStmts`/`mapExpr` already
// recurse into a nested `func`'s own body (both for its statements and its
// expressions), so one bottom-up rebuild handles the statement-name rename
// and every reference in the same pass.
import type { Expr, Stmt } from "../ast.ts";
import { mapStmts } from "../ast.ts";
import type { FnNamingMatch } from "./match.ts";

/** Renames every `_fnN`-shaped occurrence of `from` to `to` — the `func`
 *  statement's own name (root-level or nested) and every `ident`/`func`
 *  expression reference — anywhere reachable from `list`. Exported so
 *  `check.ts`'s obligation 3 ("printing `after` with the rename undone is
 *  byte-identical to printing `before`") can call it directly, per spec §6. */
export function renameIdent(list: readonly Stmt[], from: string, to: string): readonly Stmt[] {
  const renameExpr = (e: Expr): Expr => {
    if (e.k === "ident" && e.name === from) return { ...e, name: to };
    if (e.k === "func" && e.name === from) return { ...e, name: to };
    return e;
  };
  const renameStmt = (s: Stmt): Stmt => (s.k === "func" && s.name === from ? { ...s, name: to } : s);
  return mapStmts(list, renameStmt, renameExpr);
}

export function rewrite(m: FnNamingMatch): readonly Stmt[] {
  return renameIdent(m.root, m.data.from, m.data.to);
}
