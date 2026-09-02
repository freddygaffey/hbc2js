// spread-rest writer — docs/specs/passes/17-spread-rest.md §5.
import type { Expr, Param, Stmt } from "../ast.ts";
import { mapExpr } from "../ast.ts";
import type { Element, SpreadRestMatch, SpreadRestSite } from "./match.ts";
import { extractFunc } from "./match.ts";

function buildArrayElements(elements: readonly Element[]): readonly Expr[] {
  return elements.map((e) => (e.kind === "spread" ? { k: "spread" as const, arg: e.source } : e.expr));
}

export function rewriteSite(list: readonly Stmt[], site: SpreadRestSite): readonly Stmt[] {
  if (site.rule === "array") {
    const seed = list[site.startIndex]!;
    if (seed.k !== "expr" || seed.expr.k !== "assign") throw new Error("spread-rest: array seed is not an assign");
    const newSeed: Stmt = { ...seed, expr: { ...seed.expr, value: { k: "array", elements: buildArrayElements(site.elements) } } };
    return [...list.slice(0, site.startIndex), newSeed, ...list.slice(site.endIndex)];
  }
  if (site.rule === "call") {
    const applyStmt = list[site.endIndex - 1]!;
    if (applyStmt.k !== "expr" || applyStmt.expr.k !== "assign") throw new Error("spread-rest: apply site is not an assign");
    const args: Expr[] = site.args.map((a) => (a.kind === "spread" ? { k: "spread" as const, arg: a.source } : a.expr));
    const newStmt: Stmt = { ...applyStmt, expr: { ...applyStmt.expr, value: { k: "call", callee: site.callee, args } } };
    return [...list.slice(0, site.startIndex), newStmt, ...list.slice(site.endIndex)];
  }
  if (site.rule === "object") {
    const seed = list[site.startIndex]!;
    if (seed.k !== "expr" || seed.expr.k !== "assign") throw new Error("spread-rest: object seed is not an assign");
    const seedProps = site.seedProps.map((p) => ({ key: p.key, computed: p.computed, value: p.value }));
    const rest = site.props.map((p) => (p.kind === "spread" ? { k: "spreadProp" as const, arg: p.source } : { key: p.key, computed: p.computed, value: p.value }));
    const newSeed: Stmt = { ...seed, expr: { ...seed.expr, value: { k: "object", props: [...seedProps, ...rest] } } };
    return [...list.slice(0, site.startIndex), newSeed, ...list.slice(site.endIndex)];
  }
  // rest parameter (S3): the site list is whatever list carries the `func`
  // statement; rewrite the func in place — new param + call-site substitution
  // throughout its body (the call may be nested arbitrarily deep — the
  // matcher only guaranteed there is exactly one).
  const s = list[site.funcIndex]!;
  const F = extractFunc(s);
  if (F === null) throw new Error("spread-rest: rest site is not a func");
  const newParams: readonly Param[] = [...F.params, { name: site.freshName, rest: true }];
  const substitute = (e: Expr): Expr => (e === site.callNode ? { k: "ident", name: site.freshName } : e);
  const rewrittenBody = F.body.map((st) => mapStmtExprs(st, substitute));
  if (s.k === "func") return [...list.slice(0, site.funcIndex), { ...s, params: newParams, body: rewrittenBody }, ...list.slice(site.funcIndex + 1)];
  if (s.k === "init" && s.value.k === "func") return [...list.slice(0, site.funcIndex), { ...s, value: { ...s.value, params: newParams, body: rewrittenBody } }, ...list.slice(site.funcIndex + 1)];
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "func") {
    return [...list.slice(0, site.funcIndex), { ...s, expr: { ...s.expr, value: { ...s.expr.value, params: newParams, body: rewrittenBody } } }, ...list.slice(site.funcIndex + 1)];
  }
  throw new Error("spread-rest: unreachable func shape");
}

/** Substitute `fx` through every `Expr` reachable from `st`, *not* descending
 *  into a nested `func`'s own body (that is a separate statement list with
 *  its own registers — F17 §4 S3 anchors on `ctx.fnBody`'s owning function
 *  only, never a nested closure's). `mapStmts`/`mapExpr` (ast.ts) already
 *  walk into nested funcs (needed by other rungs); this rung's call site is
 *  unique per function by precondition 9, so a plain per-statement `mapExpr`
 *  that *does* recurse into nested funcs is still safe — the call being
 *  substituted only exists in `F`'s own frame, never a nested one's (it
 *  reads `F`'s own `arguments`), so `mapExpr`'s generic nested-func walk
 *  simply finds nothing to replace there. */
function mapStmtExprs(s: Stmt, fx: (e: Expr) => Expr): Stmt {
  const mapIfExpr = (e: Expr): Expr => mapExpr(e, fx);
  switch (s.k) {
    case "expr":
      return { ...s, expr: mapIfExpr(s.expr) };
    case "init":
      return { ...s, value: mapIfExpr(s.value) };
    case "if":
      return { ...s, test: mapIfExpr(s.test), then: s.then.map((x) => mapStmtExprs(x, fx)), else: s.else.map((x) => mapStmtExprs(x, fx)) };
    case "while":
      return s.test === undefined ? { ...s, body: s.body.map((x) => mapStmtExprs(x, fx)) } : { ...s, test: mapIfExpr(s.test), body: s.body.map((x) => mapStmtExprs(x, fx)) };
    case "do-while":
      return { ...s, test: mapIfExpr(s.test), body: s.body.map((x) => mapStmtExprs(x, fx)) };
    case "for":
      return { ...s, init: s.init === null ? null : mapIfExpr(s.init), test: mapIfExpr(s.test), update: s.update === null ? null : mapIfExpr(s.update), body: s.body.map((x) => mapStmtExprs(x, fx)) };
    case "labeled":
      return { ...s, body: s.body.map((x) => mapStmtExprs(x, fx)) };
    case "return":
      return { ...s, arg: s.arg === null ? null : mapIfExpr(s.arg) };
    case "throw":
      return { ...s, arg: mapIfExpr(s.arg) };
    case "try":
      return { ...s, block: s.block.map((x) => mapStmtExprs(x, fx)), handler: s.handler.map((x) => mapStmtExprs(x, fx)) };
    case "switch":
      return { ...s, disc: mapIfExpr(s.disc), cases: s.cases.map((c) => ({ ...c, test: c.test === null ? null : mapIfExpr(c.test), body: c.body.map((x) => mapStmtExprs(x, fx)) })) };
    case "iife":
      return { ...s, body: s.body.map((x) => mapStmtExprs(x, fx)) };
    default:
      return s; // decl, break, continue, func, directive, comment, raw
  }
}

export function rewrite(m: SpreadRestMatch): readonly Stmt[] {
  return rewriteSite(m.root, m.data);
}
