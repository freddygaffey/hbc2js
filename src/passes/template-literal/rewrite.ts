// template-literal writer — docs/specs/passes/14-template-literal.md §5.
//
// T1: replace the one `Reflect.apply(concat, …)` node (by identity) with a
// `template` whose quasis are the cooked chunks escaped back to raw source
// text and whose `exprs` are the very same substitution nodes. T2: replace
// the tag `call` node with a `tagged` node (raw strings verbatim — they are
// raw text already; substitutions by reference) and delete statement `A`.
// Sites are applied in the pre-order `deriveSites` produced them in, outer
// before inner: a replacement reuses every untouched child by reference, so
// an inner target that sits inside an outer site's substitution keeps its
// identity for the later `replaceNode`, whereas the reverse order would
// rebuild the outer node's spine and lose it. `src/emit/print.ts` owns
// parentheses; nothing here adds any. Exported so `check.ts` can rebuild the
// exact expected output from `before` alone.
import type { Expr, Stmt } from "../ast.ts";
import type { TemplateLiteralMatch, TemplateSite } from "./match.ts";
import { escapeForTemplate } from "./match.ts";

/** Rebuilds `e`, replacing the one node identical (`===`) to `target` with
 *  `replacement`. Never descends into a nested `func`. */
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
    case "template": {
      const exprs = e.exprs.map((x) => replaceNode(x, target, replacement));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "tagged": {
      const tag = replaceNode(e.tag, target, replacement);
      const quasi = replaceNode(e.quasi, target, replacement);
      return tag === e.tag && quasi === e.quasi ? e : { ...e, tag, quasi };
    }
    default:
      return e; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

/** Mirrors `match.ts`'s `exprFieldsOf`, rebuilding each field. */
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

/** The replacement node for one site — substitutions by reference. */
export function replacementFor(site: TemplateSite): Expr {
  if (site.kind === "t1") return { k: "template", quasis: site.chunks.map(escapeForTemplate), exprs: site.subs };
  return { k: "tagged", tag: site.tag, quasi: { k: "template", quasis: site.raw, exprs: site.subs } };
}

/** Apply every site to `list`: node replacements in site order, then the
 *  T2 `A` statements removed by identity. */
export function applySites(list: readonly Stmt[], sites: readonly TemplateSite[]): readonly Stmt[] {
  const stmts = [...list];
  const deleted = new Set<Stmt>();
  for (const site of sites) {
    stmts[site.stmtIndex] = applyReplacement(stmts[site.stmtIndex]!, site.target, replacementFor(site));
    if (site.kind === "t2") deleted.add(list[site.aIndex]!);
  }
  return stmts.filter((s) => !deleted.has(s));
}

export function rewrite(m: TemplateLiteralMatch): readonly Stmt[] {
  return applySites(m.root, m.data.sites);
}
