// object-literal writer — docs/specs/passes/20-object-literal.md §5.
import type { Expr, Stmt } from "../ast.ts";
import type { ObjectLiteralMatch } from "./match.ts";

export function rewrite(m: ObjectLiteralMatch): readonly Stmt[] {
  const { root: list, data: site } = m;
  const def = list[site.defIndex]!;
  const value: Expr = { k: "object", props: site.props };
  // Spread the original statement so the `NewObject`'s own `origin` stamp
  // survives: the rebuilt literal really does come from that instruction.
  const repl: Stmt = { ...(def as Stmt & { readonly k: "expr" }), expr: { k: "assign", target: { k: "ident", name: site.reg }, value } };
  return [...list.slice(0, site.defIndex), repl, ...list.slice(site.defIndex + 1 + site.storeCount)];
}
