// var-naming/frame.ts — a generic frame-local visitor, mirroring `../ast.ts`'s
// `walk` but STOPPING at a nested `func` boundary (never recursing into it):
// every question this rung asks is about one register's own function frame,
// and a `k:"func"` node is always a distinct Hermes register file
// (AGENT-BRIEF; `../ast.ts`'s `identUses`/`defUse` encode the same boundary
// for register names specifically). Kept pass-local (D12a: "each rung owns
// its own little helpers") rather than added to `../ast.ts`, since nothing
// else needs a *generic* (name-independent) frame-local walk — `identUses`/
// `defUse` already cover the register-specific queries other rungs need.
import type { Expr, Stmt } from "../ast.ts";

export interface FrameVisitor {
  readonly stmt?: (s: Stmt) => void;
  readonly expr?: (e: Expr) => void;
}

/** Pre-order traversal of every statement/expression reachable from `stmts`,
 *  stopping at any nested `func` (statement or expression) without
 *  recursing into its body — a register found there is a different frame's
 *  own local that happens to share a number, never this frame's binding. */
export function walkFrame(stmts: readonly Stmt[], visit: FrameVisitor): void {
  const walkExpr = (e: Expr): void => {
    visit.expr?.(e);
    switch (e.k) {
      case "member":
        walkExpr(e.obj);
        if (e.computed) walkExpr(e.prop);
        return;
      case "call":
      case "new":
        walkExpr(e.callee);
        e.args.forEach(walkExpr);
        return;
      case "bin":
      case "logical":
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case "unary":
        walkExpr(e.arg);
        return;
      case "assign":
        walkExpr(e.target);
        walkExpr(e.value);
        return;
      case "cond":
        walkExpr(e.test);
        walkExpr(e.then);
        walkExpr(e.else);
        return;
      case "array":
        e.elements.forEach(walkExpr);
        return;
      case "object":
        e.props.forEach((p) => walkExpr(p.value));
        return;
      case "seq":
        e.exprs.forEach(walkExpr);
        return;
      default:
        return; // ident, lit, this, argumentsObject, func (separate frame)
    }
  };
  const walkStmts = (list: readonly Stmt[]): void => {
    for (const s of list) {
      visit.stmt?.(s);
      switch (s.k) {
        case "expr":
          walkExpr(s.expr);
          break;
        case "init":
          walkExpr(s.value);
          break;
        case "if":
          walkExpr(s.test);
          walkStmts(s.then);
          walkStmts(s.else);
          break;
        case "while":
          if (s.test !== undefined) walkExpr(s.test);
          walkStmts(s.body);
          break;
        case "do-while":
          walkExpr(s.test);
          walkStmts(s.body);
          break;
        case "for":
          if (s.init !== null) walkExpr(s.init);
          walkExpr(s.test);
          if (s.update !== null) walkExpr(s.update);
          walkStmts(s.body);
          break;
        case "labeled":
          walkStmts(s.body);
          break;
        case "return":
          if (s.arg !== null) walkExpr(s.arg);
          break;
        case "throw":
          walkExpr(s.arg);
          break;
        case "try":
          walkStmts(s.block);
          walkStmts(s.handler);
          break;
        case "switch":
          walkExpr(s.disc);
          for (const c of s.cases) {
            if (c.test !== null) walkExpr(c.test);
            walkStmts(c.body);
          }
          break;
        case "iife":
          walkStmts(s.body);
          break;
        default:
          break; // decl, func (separate frame), break, continue, directive, comment, raw
      }
    }
  };
  walkStmts(stmts);
}

/** `true` if `e` is the bare identifier `name`. */
export function isIdentNamed(e: Expr, name: string): boolean {
  return e.k === "ident" && e.name === name;
}

/** `true` if `e` (an assign, or a `seq` of them — the shape `for.init`/
 *  `for.update` take, per `src/emit/function.ts`'s `asExprs`) assigns
 *  `name` somewhere at its top level. */
export function assignsTo(e: Expr, name: string): boolean {
  if (e.k === "assign") return isIdentNamed(e.target, name);
  if (e.k === "seq") return e.exprs.some((x) => assignsTo(x, name));
  return false;
}

/** `true` if `name` is read anywhere inside `e`, frame-locally. A generous
 *  over-approximation for an assign target (an ident assign target is
 *  visited like any other expr by `walkFrame`) is harmless here: every call
 *  site only uses this to ask "is this register touched in this
 *  sub-expression", never to count exact reads (that is `identUses`'s job). */
export function readsName(e: Expr, name: string): boolean {
  let found = false;
  walkFrame([{ k: "expr", expr: e }], {
    expr: (x) => {
      if (isIdentNamed(x, name)) found = true;
    },
  });
  return found;
}
