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

/** Every name assigned at the top level of `e` (an `assign`, or a `seq` of
 *  them — the shape `for.init`/`for.update` take). */
export function assignedNames(e: Expr): string[] {
  if (e.k === "assign") return e.target.k === "ident" ? [e.target.name] : [];
  if (e.k === "seq") return e.exprs.flatMap(assignedNames);
  return [];
}

export interface FrameOccurrences {
  readonly defs: number[];
  readonly reads: number[];
}

/** `../ast.ts`'s `defUse` shape — def/read positions by pre-order statement
 *  index, frame-local — but for *any* name, not only `isRegisterName` ones.
 *  `defUse` deliberately drops every non-register name, so spec §7's
 *  obligation 5 ("`defUse(before).get(from)` and `defUse(after).get(to)`
 *  have identical index arrays") cannot be asked of it once `to` is a real
 *  name: this walk answers the same question for both sides. Indexing
 *  mirrors `defUse` exactly (every statement, at every depth, takes the next
 *  index; a `for` head's three expressions share the `for`'s own index; a
 *  nested `func` body is never entered). Every requested name gets an entry,
 *  zero-filled when absent. */
export function frameOccurrences(stmts: readonly Stmt[], names: ReadonlySet<string>): Map<string, FrameOccurrences> {
  const out = new Map<string, FrameOccurrences>();
  for (const n of names) out.set(n, { defs: [], reads: [] });
  const rec = (name: string, kind: keyof FrameOccurrences, at: number): void => {
    out.get(name)?.[kind].push(at);
  };
  let index = 0;
  const visitExpr = (e: Expr, at: number): void => {
    if (e.k === "assign" && e.target.k === "ident") {
      rec(e.target.name, "defs", at);
      visitExpr(e.value, at);
      return;
    }
    if (e.k === "ident") {
      rec(e.name, "reads", at);
      return;
    }
    visitChildren(e, at);
  };
  const visitChildren = (e: Expr, at: number): void => {
    switch (e.k) {
      case "member":
        visitExpr(e.obj, at);
        if (e.computed) visitExpr(e.prop, at);
        return;
      case "call":
      case "new":
        visitExpr(e.callee, at);
        e.args.forEach((a) => visitExpr(a, at));
        return;
      case "bin":
      case "logical":
        visitExpr(e.left, at);
        visitExpr(e.right, at);
        return;
      case "unary":
        visitExpr(e.arg, at);
        return;
      case "assign":
        visitExpr(e.target, at);
        visitExpr(e.value, at);
        return;
      case "cond":
        visitExpr(e.test, at);
        visitExpr(e.then, at);
        visitExpr(e.else, at);
        return;
      case "array":
        e.elements.forEach((x) => visitExpr(x, at));
        return;
      case "object":
        e.props.forEach((p) => visitExpr(p.value, at));
        return;
      case "seq":
        e.exprs.forEach((x) => visitExpr(x, at));
        return;
      default:
        return; // lit, this, argumentsObject, func (separate frame)
    }
  };
  const visitStmts = (list: readonly Stmt[]): void => {
    for (const s of list) {
      const at = index++;
      switch (s.k) {
        case "expr":
          visitExpr(s.expr, at);
          break;
        case "init":
          rec(s.name, "defs", at);
          visitExpr(s.value, at);
          break;
        case "if":
          visitExpr(s.test, at);
          visitStmts(s.then);
          visitStmts(s.else);
          break;
        case "while":
          if (s.test !== undefined) visitExpr(s.test, at);
          visitStmts(s.body);
          break;
        case "do-while":
          visitExpr(s.test, at);
          visitStmts(s.body);
          break;
        case "for":
          if (s.init !== null) visitExpr(s.init, at);
          visitExpr(s.test, at);
          if (s.update !== null) visitExpr(s.update, at);
          visitStmts(s.body);
          break;
        case "labeled":
          visitStmts(s.body);
          break;
        case "return":
          if (s.arg !== null) visitExpr(s.arg, at);
          break;
        case "throw":
          visitExpr(s.arg, at);
          break;
        case "try":
          visitStmts(s.block);
          visitStmts(s.handler);
          break;
        case "switch":
          visitExpr(s.disc, at);
          for (const c of s.cases) {
            if (c.test !== null) visitExpr(c.test, at);
            visitStmts(c.body);
          }
          break;
        case "iife":
          visitStmts(s.body);
          break;
        default:
          break; // decl, break, continue, func, directive, comment, raw
      }
    }
  };
  visitStmts(stmts);
  return out;
}
