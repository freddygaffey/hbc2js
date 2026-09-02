// optional-chain writer — docs/specs/passes/18-optional-chain.md §5.
import type { Expr, Stmt } from "../ast.ts";
import type { ChainSite, NullishSite, OptionalChainMatch } from "./match.ts";

/** §5 C: build the chain expression inside-out, from `base` outward — every
 *  link this rung matched was guarded (each is preceded by a `== null`
 *  check on the previous link's own register, §4's note on why the "first
 *  link may be unguarded" case never actually arises for a run this
 *  matcher accepts), so every link becomes an `optmember`/`optcall`. */
function buildChainExpr(site: ChainSite): Expr {
  let acc: Expr = site.base;
  for (const link of site.links) {
    if (link.kind === "member") {
      acc = { k: "optmember", obj: acc, prop: link.prop!, computed: link.computed };
    } else {
      acc = { k: "optcall", callee: acc, args: link.args!, thisIsBase: true };
    }
  }
  return acc;
}

function buildChain(site: ChainSite): readonly Stmt[] {
  const commit: Stmt = { k: "expr", expr: { k: "assign", target: { k: "ident", name: site.rRes }, value: buildChainExpr(site) } };
  return [commit];
}

function buildNullish(site: NullishSite): readonly Stmt[] {
  const value: Expr = { k: "logical", op: "??", left: site.left, right: site.fallback };
  const commit: Stmt = { k: "expr", expr: { k: "assign", target: { k: "ident", name: site.rX }, value } };
  return [commit];
}

export function rewrite(m: OptionalChainMatch): readonly Stmt[] {
  const { data: site, root: list } = m;
  const before = list.slice(0, site.startIndex);
  const after = list.slice(site.endIndex);
  if (site.kind === "chain") return [...before, ...buildChain(site), ...after];
  // N-rule: also drop the folded literal write, if any.
  const head = site.foldedFrom !== null ? list.slice(0, site.foldedFrom) : before;
  return [...head, ...buildNullish(site), ...after];
}
