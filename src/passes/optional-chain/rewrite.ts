// optional-chain writer — docs/specs/passes/18-optional-chain.md §5.
import type { Expr, Stmt } from "../ast.ts";
import type { ChainSite, NullishSite, OptionalChainMatch } from "./match.ts";

/** §5 C: build the chain expression inside-out, from `base` outward — each
 *  link becomes `optmember`/`optcall` (`?.`) when its own guard was present
 *  in `before`, or a plain `member`/`call` (`.`) when it was elided (§4's
 *  closing note): the matcher keys every link strictly on the presence of
 *  its own guard, so the writer just mirrors `link.guarded` per link. */
function buildChainExpr(site: ChainSite): Expr {
  let acc: Expr = site.base;
  for (const link of site.links) {
    if (link.kind === "member") {
      acc = link.guarded ? { k: "optmember", obj: acc, prop: link.prop!, computed: link.computed } : { k: "member", obj: acc, prop: link.prop!, computed: link.computed };
    } else {
      acc = link.guarded ? { k: "optcall", callee: acc, args: link.args!, thisIsBase: true } : { k: "call", callee: acc, args: link.args! };
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
