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
  // docs/BUGS.md `object-literal-interleaved`: `hoisted` statements were
  // proven safe to commute above the whole run (`canHoist`) — moved here,
  // unmodified and in their original relative order, they are never deleted
  // the way a folded store is, only relocated.
  const span = site.storeCount + site.hoisted.length;
  return [...list.slice(0, site.defIndex), ...site.hoisted, repl, ...list.slice(site.defIndex + 1 + span)];
}
