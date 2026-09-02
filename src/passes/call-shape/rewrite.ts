// call-shape writer — docs/specs/passes/04-call-shape.md §5.
//
// Replace exactly the one captured `call` node (by identity — `match`
// captured the real node reference, never a re-derived shape) in place;
// the enclosing statement and every other expression is untouched.
// `src/emit/print.ts` owns precedence and parentheses — this never adds any.
import type { Expr, Stmt } from "../ast.ts";
import type { CallShapeMatch } from "./match.ts";

/** Rebuilds `e`, replacing the one node identical (`===`) to `target` with
 *  `replacement`. Never descends into a nested `func` (a different frame
 *  `match` never looked inside, so `target` cannot live there). */
export function replaceNode(e: Expr, target: Expr, replacement: Expr): Expr {
  if (e === target) return replacement;
  switch (e.k) {
    case "member": {
      const obj = replaceNode(e.obj, target, replacement);
      const prop = e.computed ? replaceNode(e.prop, target, replacement) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = replaceNode(e.callee, target, replacement);
      const args = e.args.map((a) => replaceNode(a, target, replacement));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = replaceNode(e.left, target, replacement);
      const right = replaceNode(e.right, target, replacement);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = replaceNode(e.arg, target, replacement);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const t = replaceNode(e.target, target, replacement);
      const v = replaceNode(e.value, target, replacement);
      return t === e.target && v === e.value ? e : { ...e, target: t, value: v };
    }
    case "cond": {
      const test = replaceNode(e.test, target, replacement);
      const then = replaceNode(e.then, target, replacement);
      const els = replaceNode(e.else, target, replacement);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => replaceNode(x, target, replacement));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        if ("k" in p) {
          const v = replaceNode(p.arg, target, replacement);
          if (v !== p.arg) changed = true;
          return v === p.arg ? p : { ...p, arg: v };
        }
        const v = replaceNode(p.value, target, replacement);
        if (v !== p.value) changed = true;
        return v === p.value ? p : { ...p, value: v };
      });
      return changed ? { ...e, props } : e;
    }
    case "seq": {
      const exprs = e.exprs.map((x) => replaceNode(x, target, replacement));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    default:
      return e; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

/** Mirrors `match.ts`'s `exprFieldsOf`, rebuilding each field instead of
 *  just reading it. Exported so `check.ts` can build the exact expected
 *  rewrite from `before` alone and compare it structurally to `after`. */
export function applyReplacement(s: Stmt, target: Expr, replacement: Expr): Stmt {
  switch (s.k) {
    case "expr":
      return { ...s, expr: replaceNode(s.expr, target, replacement) };
    case "init":
      return { ...s, value: replaceNode(s.value, target, replacement) };
    case "if":
      return { ...s, test: replaceNode(s.test, target, replacement) };
    case "while":
      return s.test === undefined ? s : { ...s, test: replaceNode(s.test, target, replacement) };
    case "do-while":
      return { ...s, test: replaceNode(s.test, target, replacement) };
    case "for":
      return { ...s, init: s.init === null ? null : replaceNode(s.init, target, replacement), test: replaceNode(s.test, target, replacement), update: s.update === null ? null : replaceNode(s.update, target, replacement) };
    case "return":
      return s.arg === null ? s : { ...s, arg: replaceNode(s.arg, target, replacement) };
    case "throw":
      return { ...s, arg: replaceNode(s.arg, target, replacement) };
    case "switch":
      return { ...s, disc: replaceNode(s.disc, target, replacement) };
    default:
      return s;
  }
}

export function rewrite(m: CallShapeMatch): readonly Stmt[] {
  const { stmtIndex, target, replacement } = m.data;
  const list = m.root;
  const newStmt = applyReplacement(list[stmtIndex]!, target, replacement);
  return [...list.slice(0, stmtIndex), newStmt, ...list.slice(stmtIndex + 1)];
}
