// global-access writer — docs/specs/passes/03-global-access.md §5.
//
// Delete `L[guardIndex]`; in `L[useIndex]` replace the one matched `G.p`
// member read with a bare `{k:"ident", name:p}`. Nothing else moves. A now-
// dead `rN = globalThis` store is left for a later pass (01 F10 / var-naming,
// per §5) to prune.
import type { Expr, Stmt } from "../ast.ts";
import { isTargetRead } from "./match.ts";
import type { GlobalAccessMatch } from "./match.ts";

/** Rebuilds `e`, replacing the one (already-verified-unique) `global.name`
 *  read with a bare identifier. Never descends into a nested `func` (a
 *  different frame `match` never looked inside). */
function replaceRead(e: Expr, global: Expr, name: string): Expr {
  // `global: true` tells `src/emit/scope-check.ts`'s EM-01 `checkBindings`
  // that this bare name is a deliberately-emitted global read, not an unbound
  // identifier — the emitter's one licence to accept a free name (a global
  // *read* only; writes / `DeclareGlobalVar` keep their `globalThis.x` form).
  if (isTargetRead(e, global, name)) return { k: "ident", name, global: true };
  switch (e.k) {
    case "member": {
      const obj = replaceRead(e.obj, global, name);
      const prop = e.computed ? replaceRead(e.prop, global, name) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = replaceRead(e.callee, global, name);
      const args = e.args.map((a) => replaceRead(a, global, name));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = replaceRead(e.left, global, name);
      const right = replaceRead(e.right, global, name);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = replaceRead(e.arg, global, name);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const target = replaceRead(e.target, global, name);
      const value = replaceRead(e.value, global, name);
      return target === e.target && value === e.value ? e : { ...e, target, value };
    }
    case "cond": {
      const test = replaceRead(e.test, global, name);
      const then = replaceRead(e.then, global, name);
      const els = replaceRead(e.else, global, name);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => replaceRead(x, global, name));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        const v = replaceRead(p.value, global, name);
        if (v !== p.value) changed = true;
        return v === p.value ? p : { ...p, value: v };
      });
      return changed ? { ...e, props } : e;
    }
    case "seq": {
      const exprs = e.exprs.map((x) => replaceRead(x, global, name));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    default:
      return e; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

/** Mirrors `match.ts`'s `topLevelExprFields`, rebuilding each field instead
 *  of just reading it. */
export function substitute(s: Stmt, global: Expr, name: string): Stmt {
  switch (s.k) {
    case "expr":
      return { ...s, expr: replaceRead(s.expr, global, name) };
    case "init":
      return { ...s, value: replaceRead(s.value, global, name) };
    case "if":
      return { ...s, test: replaceRead(s.test, global, name) };
    case "while":
      return s.test === undefined ? s : { ...s, test: replaceRead(s.test, global, name) };
    case "do-while":
      return { ...s, test: replaceRead(s.test, global, name) };
    case "for":
      return { ...s, init: s.init === null ? null : replaceRead(s.init, global, name), test: replaceRead(s.test, global, name), update: s.update === null ? null : replaceRead(s.update, global, name) };
    case "return":
      return s.arg === null ? s : { ...s, arg: replaceRead(s.arg, global, name) };
    case "throw":
      return { ...s, arg: replaceRead(s.arg, global, name) };
    case "switch":
      return { ...s, disc: replaceRead(s.disc, global, name) };
    default:
      return s;
  }
}

export function rewrite(m: GlobalAccessMatch): readonly Stmt[] {
  const { guardIndex, useIndex, name, global } = m.data;
  const list = m.root;
  const withoutGuard = [...list.slice(0, guardIndex), ...list.slice(guardIndex + 1)];
  const newUseIndex = useIndex - 1; // useIndex > guardIndex always (§4 scans forward from guardIndex + 1)
  const rewritten = substitute(withoutGuard[newUseIndex]!, global, name);
  return [...withoutGuard.slice(0, newUseIndex), rewritten, ...withoutGuard.slice(newUseIndex + 1)];
}
