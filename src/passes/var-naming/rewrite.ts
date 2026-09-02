// var-naming writer — docs/specs/passes/07-var-naming.md §5.
//
// Frame-local rename: unlike `fn-naming`'s `renameIdents` (built on
// `mapStmts`/`mapExpr`, which recurse into nested `func` bodies — correct
// for a module-scoped `_fnN`), a register's `rN` in a nested closure is that
// closure's own distinct frame slot (AGENT-BRIEF; `identUses`/`defUse`
// encode exactly this boundary). `renameRegistersInFrame` walks like
// `frame.ts`'s `frameOccurrences` does and returns *without recursing* at
// any `{k:"func"}` node (statement or expression), renaming only the current
// frame: the leading `decl.names` entries, every `ident` read, every
// `assign`-target, and every `init`-name — for all of the site's renames at
// once (one rebuild, not one per name; spec 05 §4's batched convention).
import type { Expr, Stmt } from "../ast.ts";
import { mapPattern } from "../ast.ts";
import type { VarNamingMatch } from "./match.ts";

type Mapping = ReadonlyMap<string, string>;

function renameExpr(e: Expr, map: Mapping): Expr {
  switch (e.k) {
    case "ident": {
      const to = map.get(e.name);
      return to === undefined ? e : { ...e, name: to };
    }
    case "member": {
      const obj = renameExpr(e.obj, map);
      const prop = e.computed ? renameExpr(e.prop, map) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = renameExpr(e.callee, map);
      const args = e.args.map((a) => renameExpr(a, map));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = renameExpr(e.left, map);
      const right = renameExpr(e.right, map);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = renameExpr(e.arg, map);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const target = renameExpr(e.target, map);
      const value = renameExpr(e.value, map);
      return target === e.target && value === e.value ? e : { ...e, target, value };
    }
    case "cond": {
      const test = renameExpr(e.test, map);
      const then = renameExpr(e.then, map);
      const els = renameExpr(e.else, map);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => renameExpr(x, map));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      const props = e.props.map((p) => ("k" in p ? { ...p, arg: renameExpr(p.arg, map) } : { ...p, value: renameExpr(p.value, map) }));
      return props.every((p, i) => ("k" in p ? p.arg === (e.props[i] as { arg: unknown }).arg : p.value === (e.props[i] as { value: unknown }).value)) ? e : { ...e, props };
    }
    case "seq": {
      const exprs = e.exprs.map((x) => renameExpr(x, map));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "destructure": {
      // F16 §3: "the same machinery as plain idents" — `mapPattern` renames
      // a `pid` leaf by round-tripping it through this very `renameExpr`
      // as a synthetic `ident` node, so no pattern-specific rename logic
      // lives here at all.
      const source = renameExpr(e.source, map);
      const pattern = mapPattern(e.pattern, (x) => renameExpr(x, map));
      return source === e.source && pattern === e.pattern ? e : { ...e, source, pattern };
    }
    default:
      return e; // lit, this, argumentsObject, func (separate frame — never recurse)
  }
}

function renameStmts(list: readonly Stmt[], map: Mapping): readonly Stmt[] {
  const renameOne = (s: Stmt): Stmt => {
    switch (s.k) {
      case "expr":
        return { ...s, expr: renameExpr(s.expr, map) };
      case "decl":
        return s.names.some((n) => map.has(n)) ? { ...s, names: s.names.map((n) => map.get(n) ?? n) } : s;
      case "init":
        return { ...s, name: map.get(s.name) ?? s.name, value: renameExpr(s.value, map) };
      case "if":
        return { ...s, test: renameExpr(s.test, map), then: renameStmts(s.then, map), else: renameStmts(s.else, map) };
      case "while":
        return s.test === undefined ? { ...s, body: renameStmts(s.body, map) } : { ...s, test: renameExpr(s.test, map), body: renameStmts(s.body, map) };
      case "do-while":
        return { ...s, test: renameExpr(s.test, map), body: renameStmts(s.body, map) };
      case "for":
        return {
          ...s,
          init: s.init === null ? null : renameExpr(s.init, map),
          test: renameExpr(s.test, map),
          update: s.update === null ? null : renameExpr(s.update, map),
          body: renameStmts(s.body, map),
        };
      case "labeled":
        return { ...s, body: renameStmts(s.body, map) };
      case "return":
        return { ...s, arg: s.arg === null ? null : renameExpr(s.arg, map) };
      case "throw":
        return { ...s, arg: renameExpr(s.arg, map) };
      case "try":
        return { ...s, block: renameStmts(s.block, map), handler: renameStmts(s.handler, map) };
      case "switch":
        return {
          ...s,
          disc: renameExpr(s.disc, map),
          cases: s.cases.map((c) => ({ ...c, test: c.test === null ? null : renameExpr(c.test, map), body: renameStmts(c.body, map) })),
        };
      case "iife":
        return { ...s, body: renameStmts(s.body, map) };
      case "func":
        return s; // separate frame — never recurse into a nested func's own body
      default:
        return s; // break, continue, directive, comment, raw
    }
  };
  return list.map(renameOne);
}

/** Renames every occurrence of each key of `mapping` to its value in
 *  `list`'s own frame only: the leading `decl.names` entries and every
 *  `ident`/assign-target/`init`-name reachable without crossing a
 *  `{k:"func"}` boundary. Exported so `check.ts`'s obligation 3 ("undoing
 *  the renames reproduces `before` byte-identically") can call it with the
 *  inverse mapping, per spec §7. */
export function renameRegistersInFrame(list: readonly Stmt[], mapping: Mapping): readonly Stmt[] {
  return renameStmts(list, mapping);
}

/** The single-pair form spec §5 names (`renameRegisterInFrame(list, from,
 *  to)`), kept for unit tests and readers of the spec. */
export function renameRegisterInFrame(list: readonly Stmt[], from: string, to: string): readonly Stmt[] {
  return renameRegistersInFrame(list, new Map([[from, to]]));
}

export function rewrite(m: VarNamingMatch): readonly Stmt[] {
  return renameRegistersInFrame(m.root, new Map(m.data.renames.map((r) => [r.from, r.to])));
}
