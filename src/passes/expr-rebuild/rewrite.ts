// expr-rebuild writer — docs/specs/passes/02-expr-rebuild.md §5.
import type { Expr, Stmt } from "../ast.ts";
import { isPure } from "../ast.ts";
import type { ExprRebuildMatch } from "./match.ts";

/** Rebuilds `s`'s one R1a-eligible field (mirrors `match.ts`'s
 *  `topLevelExprOf`) with `rX` replaced by `value` at the single read
 *  `match` found. */
export function substituteTopLevel(s: Stmt, reg: string, value: Expr): Stmt {
  switch (s.k) {
    case "expr":
      return { ...s, expr: replaceRead(s.expr, reg, value) };
    case "init":
      return { ...s, value: replaceRead(s.value, reg, value) };
    case "return":
      return s.arg === null ? s : { ...s, arg: replaceRead(s.arg, reg, value) };
    case "throw":
      return { ...s, arg: replaceRead(s.arg, reg, value) };
    case "if":
      return { ...s, test: replaceRead(s.test, reg, value) };
    case "while":
      return s.test === undefined ? s : { ...s, test: replaceRead(s.test, reg, value) };
    case "do-while":
      return { ...s, test: replaceRead(s.test, reg, value) };
    case "for":
      return { ...s, test: replaceRead(s.test, reg, value) };
    case "switch":
      return { ...s, disc: replaceRead(s.disc, reg, value) };
    default:
      return s;
  }
}

/** Replaces the (single, already-verified) *read* of `reg` in `e` with
 *  `value` — never the target of an `assign` (that is a write, untouched),
 *  never descending into a nested `func` (a different frame `match` already
 *  refused to cross). Never re-parenthesises: `src/emit/print.ts` owns
 *  precedence. */
function replaceRead(e: Expr, reg: string, value: Expr): Expr {
  switch (e.k) {
    case "ident":
      return e.name === reg ? value : e;
    case "assign": {
      const target = e.target.k === "ident" && e.target.name === reg ? e.target : replaceRead(e.target, reg, value);
      const val = replaceRead(e.value, reg, value);
      return target === e.target && val === e.value ? e : { ...e, target, value: val };
    }
    case "member": {
      const obj = replaceRead(e.obj, reg, value);
      const prop = e.computed ? replaceRead(e.prop, reg, value) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = replaceRead(e.callee, reg, value);
      const args = e.args.map((a) => replaceRead(a, reg, value));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = replaceRead(e.left, reg, value);
      const right = replaceRead(e.right, reg, value);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = replaceRead(e.arg, reg, value);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "cond": {
      const test = replaceRead(e.test, reg, value);
      const then = replaceRead(e.then, reg, value);
      const els = replaceRead(e.else, reg, value);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => replaceRead(x, reg, value));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        if ("k" in p) {
          const v = replaceRead(p.arg, reg, value);
          if (v !== p.arg) changed = true;
          return v === p.arg ? p : { ...p, arg: v };
        }
        const v = replaceRead(p.value, reg, value);
        if (v !== p.value) changed = true;
        return v === p.value ? p : { ...p, value: v };
      });
      return changed ? { ...e, props } : e;
    }
    case "seq": {
      const exprs = e.exprs.map((x) => replaceRead(x, reg, value));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "func":
      return e; // a different frame; match() already refused any reg mention here.
    default:
      return e; // lit, this, argumentsObject
  }
}

/** `list` with index `i` removed, in a single allocation and a single pass.
 *  The old `[...list.slice(0, i), ...list.slice(i + 1)]` form allocated two
 *  intermediate slices *and* the spread target, i.e. three arrays and ~2x
 *  `list.length` element copies per call, and `check` called `rewrite` a
 *  second time per site to re-derive the expected `after` - eight array
 *  allocations per applied site on a module-root-shaped function. One
 *  allocation and one copy is the floor for an immutable statement array
 *  (docs/BUGS.md's superlinear-pass row, part 4; the rest needs a persistent
 *  list representation - docs/PUSHBACK.md P-32/P-33). */
function withoutAt(list: readonly Stmt[], i: number): Stmt[] {
  const out = new Array<Stmt>(list.length - 1);
  for (let k = 0; k < i; k++) out[k] = list[k]!;
  for (let k = i + 1; k < list.length; k++) out[k - 1] = list[k]!;
  return out;
}

/** The statement an impure R1b leaves behind at `i`: the store is dropped,
 *  its value expression kept for its effects. Shared with `check.ts`, which
 *  re-derives the expected `after` a window at a time rather than by
 *  rebuilding the whole list. */
export function impureStoreRemnant(value: Expr): Stmt {
  return { k: "expr", expr: value };
}

export function rewrite(m: ExprRebuildMatch): readonly Stmt[] {
  const { rule, i, j, reg, value } = m.data;
  const list = m.root;

  if (rule === "R1c") return withoutAt(list, i);
  if (rule === "R1b") {
    if (isPure(value)) return withoutAt(list, i);
    const out = list.slice(); // keep the effect, drop the store
    out[i] = impureStoreRemnant(value);
    return out;
  }
  // R1a: drop the store at `i` and fold `value` into the read at `j`; `j > i`
  // always, so the read shifts down by exactly one.
  const out = withoutAt(list, i);
  const newJ = j - 1;
  out[newJ] = substituteTopLevel(out[newJ]!, reg, value);
  return out;
}
