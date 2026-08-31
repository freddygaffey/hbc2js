// var-naming writer — docs/specs/passes/07-var-naming.md §5.
//
// Frame-local rename: unlike `fn-naming`'s `renameIdent` (built on
// `mapStmts`/`mapExpr`, which recurse into nested `func` bodies — correct
// for a module-scoped `_fnN`), a register's `rN` in a nested closure is that
// closure's own distinct frame slot (AGENT-BRIEF; `identUses`/`defUse`
// encode exactly this boundary). `renameRegisterInFrame` walks like
// `collectDefValues`/`defUse` do and returns *without recursing* at any
// `{k:"func"}` node (statement or expression), renaming only the current
// frame: the leading `decl.names` entry, every `ident` read, every
// `assign`-target, and every `init`-name.
import type { Expr, Stmt } from "../ast.ts";
import type { VarNamingMatch } from "./match.ts";

function renameExpr(e: Expr, from: string, to: string): Expr {
  switch (e.k) {
    case "ident":
      return e.name === from ? { ...e, name: to } : e;
    case "member": {
      const obj = renameExpr(e.obj, from, to);
      const prop = e.computed ? renameExpr(e.prop, from, to) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = renameExpr(e.callee, from, to);
      const args = e.args.map((a) => renameExpr(a, from, to));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = renameExpr(e.left, from, to);
      const right = renameExpr(e.right, from, to);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = renameExpr(e.arg, from, to);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const target = renameExpr(e.target, from, to);
      const value = renameExpr(e.value, from, to);
      return target === e.target && value === e.value ? e : { ...e, target, value };
    }
    case "cond": {
      const test = renameExpr(e.test, from, to);
      const then = renameExpr(e.then, from, to);
      const els = renameExpr(e.else, from, to);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => renameExpr(x, from, to));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      const props = e.props.map((p) => ({ ...p, value: renameExpr(p.value, from, to) }));
      return props.every((p, i) => p.value === e.props[i]!.value) ? e : { ...e, props };
    }
    case "seq": {
      const exprs = e.exprs.map((x) => renameExpr(x, from, to));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    default:
      return e; // lit, this, argumentsObject, func (separate frame — never recurse)
  }
}

function renameStmts(list: readonly Stmt[], from: string, to: string): readonly Stmt[] {
  const renameOne = (s: Stmt): Stmt => {
    switch (s.k) {
      case "expr":
        return { ...s, expr: renameExpr(s.expr, from, to) };
      case "decl":
        return s.names.includes(from) ? { ...s, names: s.names.map((n) => (n === from ? to : n)) } : s;
      case "init":
        return { ...s, name: s.name === from ? to : s.name, value: renameExpr(s.value, from, to) };
      case "if":
        return { ...s, test: renameExpr(s.test, from, to), then: renameStmts(s.then, from, to), else: renameStmts(s.else, from, to) };
      case "while":
        return s.test === undefined ? { ...s, body: renameStmts(s.body, from, to) } : { ...s, test: renameExpr(s.test, from, to), body: renameStmts(s.body, from, to) };
      case "do-while":
        return { ...s, test: renameExpr(s.test, from, to), body: renameStmts(s.body, from, to) };
      case "for":
        return {
          ...s,
          init: s.init === null ? null : renameExpr(s.init, from, to),
          test: renameExpr(s.test, from, to),
          update: s.update === null ? null : renameExpr(s.update, from, to),
          body: renameStmts(s.body, from, to),
        };
      case "labeled":
        return { ...s, body: renameStmts(s.body, from, to) };
      case "return":
        return { ...s, arg: s.arg === null ? null : renameExpr(s.arg, from, to) };
      case "throw":
        return { ...s, arg: renameExpr(s.arg, from, to) };
      case "try":
        return { ...s, block: renameStmts(s.block, from, to), handler: renameStmts(s.handler, from, to) };
      case "switch":
        return {
          ...s,
          disc: renameExpr(s.disc, from, to),
          cases: s.cases.map((c) => ({ ...c, test: c.test === null ? null : renameExpr(c.test, from, to), body: renameStmts(c.body, from, to) })),
        };
      case "iife":
        return { ...s, body: renameStmts(s.body, from, to) };
      case "func":
        return s; // separate frame — never recurse into a nested func's own body
      default:
        return s; // break, continue, directive, comment, raw
    }
  };
  return list.map(renameOne);
}

/** Renames every occurrence of register `from` to `to` in `list`'s own frame
 *  only: the leading `decl.names` entry and every `ident`/assign-target/
 *  `init`-name reachable without crossing a `{k:"func"}` boundary. Exported
 *  so `check.ts`'s obligation 3 ("undoing the rename reproduces `before`
 *  byte-identically") can call it directly, per spec §7. */
export function renameRegisterInFrame(list: readonly Stmt[], from: string, to: string): readonly Stmt[] {
  return renameStmts(list, from, to);
}

export function rewrite(m: VarNamingMatch): readonly Stmt[] {
  return renameRegisterInFrame(m.root, m.data.from, m.data.to);
}
