// docs/specs/passes/01-framework-fixes.md F8 — framework for stage B (the JS
// AST, `src/emit/ast.ts`'s `Stmt`/`Expr`), exactly as `tree.ts` is framework
// for stage A. May import `src/emit/ast.ts` and `src/emit/print.ts`; a rung
// itself never may (D12a) — anything a rung needs from the emitter belongs
// here, copied or wrapped, same rule `tree.ts` follows for stage A.
//
// This file also carries F1's stage-B driver: `applyAstPasses` mirrors
// `driver.ts`'s `applyPasses` at the granularity F1 specifies — a statement
// list, not a tree node — with a cheaper whole-function guard (`parses`
// once per pass, not the stage-A round-trip per site).
import vm from "node:vm";
import type { Diagnostic } from "../errors.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Expr, Param, Stmt } from "../emit/ast.ts";
import { printProgram } from "../emit/print.ts";
import type { AbandonedRecord, AppliedRecord, CheckResult, Pass, PassContext } from "./types.ts";

// F8 gap (spec `docs/specs/passes/02-expr-rebuild.md`): a stage-B rung's
// `match`/`rewrite`/`check` signatures need to *name* `Stmt`/`Expr`, and
// `../../emit/ast.ts` is not on D12a's allowlist — only `../ast.ts` (this
// file) is. Without this re-export no stage-B rung could be typed at all.
export type { Expr, Param, Pattern, PatternElement, Stmt } from "../emit/ast.ts";
export { p } from "../emit/ast.ts";
import type { Pattern, PatternElement } from "../emit/ast.ts";

// docs/specs/passes/05-fn-naming.md §6 obligation 3 ("printing `before`, and
// printing `after` with the rename undone, is byte-identical — implement
// literally: `printProgram(before) === printProgram(renameIdent(after, to,
// from))`") needs `printProgram` itself, same D12a gap as the type re-export
// above: `../../emit/print.ts` is not on the allowlist, only this file is.
export { printProgram } from "../emit/print.ts";

// D20 (docs/specs/passes/08-jsx-recovery.md §3/§6): the `jsx` node's parts
// and its exact inverse, re-exported for the same D12a reason — the
// `jsx-recover` rung builds the node and its `check` lowers it back.
export type { JsxAttr, JsxChild, JsxFactory } from "../emit/ast.ts";
export { jsxToCall } from "../emit/ast.ts";
import type { JsxFactory } from "../emit/ast.ts";
import { jsxToCall } from "../emit/ast.ts";

/** Every sub-expression of a `jsx` node, in the order its call evaluates
 *  them: factory callee, tag, config fields (attrs and children in their
 *  original order), then the automatic runtime's key and trailing args. */
export function jsxParts(e: Extract<Expr, { k: "jsx" }>): readonly Expr[] {
  const out: Expr[] = [e.factory.callee, e.tag];
  const attrs = e.attrs.map((a) => ("spread" in a ? a.spread : a.value)).filter((x): x is Expr => x !== null);
  const children = e.children.map((c) => (c.k === "expr" ? c.expr : c.lit));
  if (e.factory.runtime === "automatic") {
    const at = e.factory.childrenAt ?? attrs.length;
    out.push(...attrs.slice(0, at), ...children, ...attrs.slice(at));
    if (e.factory.key !== null) out.push(e.factory.key);
    out.push(...e.factory.rest);
  } else {
    if (e.factory.nullProps !== null) out.push(e.factory.nullProps);
    out.push(...attrs, ...children);
  }
  return out;
}

export type { ClassMember } from "../emit/ast.ts";

/** F24-1: every sub-expression of a `class` node that is *evaluated when the
 *  class is defined*, in evaluation order: the `extends` expression, then per
 *  member its computed key and (for a field) its initialiser. A method body is
 *  not evaluated and is deliberately absent. */
export function classParts(e: Extract<Expr, { k: "class" }>): readonly Expr[] {
  const out: Expr[] = [];
  if (e.superClass !== null) out.push(e.superClass);
  for (const m of e.members) {
    if (m.computed) out.push(m.key);
    if (m.kind === "field" && m.value !== null) out.push(m.value);
  }
  return out;
}

/** F16 (docs/specs/passes/16-destructure.md §3): read-only recursion into a
 *  pattern's own expressions. A `pid` leaf is reported to `onExpr` as a
 *  synthetic `{k:"ident"}` node (never a real tree node, never recursed into
 *  further) — the trick that lets every existing `ident`-keyed consumer of
 *  `walk`'s visitor (`freeNames`'s "count it as used", a rename callback)
 *  see a pattern's assignment targets for free, with no second
 *  implementation: `freeNames` counts a `pid` name as used-not-bound exactly
 *  because it is never added to that walk's `bound` set (it is a write
 *  target, not a binding — F16 §3). */
export function walkPattern(p: Pattern, onExpr: (e: Expr) => void): void {
  switch (p.k) {
    case "pid":
      onExpr({ k: "ident", name: p.name });
      return;
    case "parr":
      for (const el of p.elements) walkPatternElement(el, onExpr);
      return;
    case "pobj":
      for (const prop of p.props) walkPatternElement(prop.value, onExpr);
      return;
  }
}

function walkPatternElement(el: PatternElement, onExpr: (e: Expr) => void): void {
  if (el.k === "hole") return;
  walkPattern(el.target, onExpr);
  if (el.k === "pel" && el.init !== undefined) onExpr(el.init);
}

/** F16: rebuild a pattern through `fx`, the same rebuilding contract
 *  `mapExpr` uses. A `pid` name is renamed by round-tripping it through a
 *  synthetic `{k:"ident"}` node — so a rename callback written against plain
 *  `ident` nodes (`var-naming`'s own `renameExpr`, spec 16 §3's "one shared
 *  walk, not a second implementation") renames pattern targets with zero
 *  pattern-specific code of its own. */
export function mapPattern(p: Pattern, fx: (e: Expr) => Expr): Pattern {
  switch (p.k) {
    case "pid": {
      const renamed = fx({ k: "ident", name: p.name });
      return renamed.k === "ident" && renamed.name !== p.name ? { ...p, name: renamed.name } : p;
    }
    case "parr": {
      const elements = p.elements.map((el) => mapPatternElement(el, fx));
      return elements.every((el, i) => el === p.elements[i]) ? p : { ...p, elements };
    }
    case "pobj": {
      const props = p.props.map((prop) => {
        const value = mapPatternElement(prop.value, fx);
        return value === prop.value ? prop : { ...prop, value };
      });
      return props.every((pr, i) => pr === p.props[i]) ? p : { ...p, props };
    }
  }
}

function mapPatternElement(el: PatternElement, fx: (e: Expr) => Expr): PatternElement {
  if (el.k === "hole") return el;
  const target = mapPattern(el.target, fx);
  if (el.k === "prest") return target === el.target ? el : { ...el, target };
  const init = el.init === undefined ? undefined : mapExpr(el.init, fx);
  if (target === el.target && init === el.init) return el;
  return init === undefined ? { k: "pel", target } : { k: "pel", target, init };
}

// ---------------------------------------------------------------------------
// Visitor / rebuilding maps over Stmt / Expr.
// ---------------------------------------------------------------------------

export interface Visitor {
  readonly stmt?: (s: Stmt) => void;
  readonly expr?: (e: Expr) => void;
}

/** Read-only pre-order traversal of every statement and expression reachable
 *  from `stmts`, *including* nested `func` bodies (unlike `stmtLists`, which
 *  stops at a function boundary because that body is a separate site). */
export function walk(stmts: readonly Stmt[], visit: Visitor): void {
  const walkExpr = (e: Expr): void => {
    visit.expr?.(e);
    switch (e.k) {
      case "member":
      case "optmember": // F18
        walkExpr(e.obj);
        walkExpr(e.prop);
        return;
      case "call":
      case "optcall": // F18
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
        e.props.forEach((p) => walkExpr("k" in p ? p.arg : p.value));
        return;
      case "spread": // F17
        walkExpr(e.arg);
        return;
      case "await": // F25-1
        walkExpr(e.arg);
        return;
      case "yield": // F25-1 (`yield` with no argument has none to walk)
        if (e.arg !== null) walkExpr(e.arg);
        return;
      case "seq":
        e.exprs.forEach(walkExpr);
        return;
      case "template": // F14
        e.exprs.forEach(walkExpr);
        return;
      case "tagged": // F14
        walkExpr(e.tag);
        walkExpr(e.quasi);
        return;
      case "jsx": // D20
        jsxParts(e).forEach(walkExpr);
        return;
      case "destructure": // F16
        walkExpr(e.source);
        walkPattern(e.pattern, walkExpr);
        return;
      case "class": // F24-1
        classParts(e).forEach(walkExpr);
        // A method/accessor value is walked as the `func` expression it is, so
        // every consumer's own binding rules (`freeNames`'s parameter scope)
        // apply to it unchanged.
        for (const m of e.members) if (m.value !== null && m.kind !== "field") walkExpr(m.value);
        return;
      case "func":
        for (const param of e.params) if (param.init !== undefined) walkExpr(param.init);
        walkStmts(e.body);
        return;
      default:
        return; // ident, lit, this, argumentsObject
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
        case "for-in":
        case "for-of":
          walkExpr(s.left);
          walkExpr(s.right);
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
        case "classdecl": // F24-1
          walkExpr(s.value);
          break;
        case "func":
          for (const param of s.params) if (param.init !== undefined) walkExpr(param.init);
          walkStmts(s.body);
          break;
        case "iife":
          walkStmts(s.body);
          break;
        default:
          break; // decl, break, continue, directive, comment, raw
      }
    }
  };
  walkStmts(stmts);
}

/** F15: rebuild every `param.init` through `fx`, keeping a `Param` object
 *  identity-stable (and the whole array's) when nothing under it changed. */
function mapParams(params: readonly Param[], fx: (e: Expr) => Expr): readonly Param[] {
  let changed = false;
  const out = params.map((param) => {
    if (param.init === undefined) return param;
    const init = mapExpr(param.init, fx);
    if (init === param.init) return param;
    changed = true;
    return { ...param, init };
  });
  return changed ? out : params;
}

/** Post-order rebuild of every `Expr` reachable from `e` (including nested
 *  `func` bodies), then `fx` on `e` itself. Only wraps a node in a new object
 *  when a child actually changed, so an untouched subtree keeps its identity. */
export function mapExpr(e: Expr, fx: (e: Expr) => Expr): Expr {
  let rebuilt: Expr;
  switch (e.k) {
    case "member":
    case "optmember": { // F18
      const obj = mapExpr(e.obj, fx);
      const prop = mapExpr(e.prop, fx);
      rebuilt = obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
      break;
    }
    case "call":
    case "optcall": // F18
    case "new": {
      const callee = mapExpr(e.callee, fx);
      const args = e.args.map((a) => mapExpr(a, fx));
      rebuilt = callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
      break;
    }
    case "bin":
    case "logical": {
      const left = mapExpr(e.left, fx);
      const right = mapExpr(e.right, fx);
      rebuilt = left === e.left && right === e.right ? e : { ...e, left, right };
      break;
    }
    case "unary": {
      const arg = mapExpr(e.arg, fx);
      rebuilt = arg === e.arg ? e : { ...e, arg };
      break;
    }
    case "assign": {
      const target = mapExpr(e.target, fx);
      const value = mapExpr(e.value, fx);
      rebuilt = target === e.target && value === e.value ? e : { ...e, target, value };
      break;
    }
    case "cond": {
      const test = mapExpr(e.test, fx);
      const then = mapExpr(e.then, fx);
      const els = mapExpr(e.else, fx);
      rebuilt = test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
      break;
    }
    case "array": {
      const elements = e.elements.map((x) => mapExpr(x, fx));
      rebuilt = elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
      break;
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        if ("k" in p) {
          const arg = mapExpr(p.arg, fx);
          if (arg !== p.arg) changed = true;
          return arg === p.arg ? p : { ...p, arg };
        }
        const value = mapExpr(p.value, fx);
        if (value !== p.value) changed = true;
        return value === p.value ? p : { ...p, value };
      });
      rebuilt = changed ? { ...e, props } : e;
      break;
    }
    case "spread": { // F17
      const arg = mapExpr(e.arg, fx);
      rebuilt = arg === e.arg ? e : { ...e, arg };
      break;
    }
    case "seq": {
      const exprs = e.exprs.map((x) => mapExpr(x, fx));
      rebuilt = exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
      break;
    }
    case "template": {
      // F14
      const exprs = e.exprs.map((x) => mapExpr(x, fx));
      rebuilt = exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
      break;
    }
    case "tagged": {
      // F14
      const tag = mapExpr(e.tag, fx);
      const quasi = mapExpr(e.quasi, fx);
      rebuilt = tag === e.tag && quasi === e.quasi ? e : { ...e, tag, quasi };
      break;
    }
    case "jsx": {
      // D20: rebuild every sub-expression (tag, attrs, children, factory).
      let changed = false;
      const sub = (x: Expr): Expr => {
        const y = mapExpr(x, fx);
        if (y !== x) changed = true;
        return y;
      };
      const tag = sub(e.tag);
      const tagDisplay = e.tagDisplay === undefined ? undefined : sub(e.tagDisplay);
      const attrs = e.attrs.map((a) => ("spread" in a ? { spread: sub(a.spread) } : { name: a.name, value: a.value === null ? null : sub(a.value) }));
      const children = e.children.map((c) => (c.k === "expr" ? { k: "expr" as const, expr: sub(c.expr) } : { k: "text" as const, lit: sub(c.lit) }));
      const f = e.factory;
      const factory: JsxFactory = f.runtime === "automatic" ? { ...f, callee: sub(f.callee), key: f.key === null ? null : sub(f.key), rest: f.rest.map(sub) } : { ...f, callee: sub(f.callee), nullProps: f.nullProps === null ? null : sub(f.nullProps) };
      rebuilt = changed ? { ...e, tag, ...(tagDisplay === undefined ? {} : { tagDisplay }), attrs, children, factory } : e;
      break;
    }
    case "destructure": {
      // F16
      const source = mapExpr(e.source, fx);
      const pattern = mapPattern(e.pattern, fx);
      rebuilt = source === e.source && pattern === e.pattern ? e : { ...e, source, pattern };
      break;
    }
    case "class": { // F24-1
      const superClass = e.superClass === null ? null : mapExpr(e.superClass, fx);
      let changed = superClass !== e.superClass;
      const members = e.members.map((m) => {
        const key = mapExpr(m.key, fx);
        const value = m.value === null ? null : mapExpr(m.value, fx);
        if (key === m.key && value === m.value) return m;
        changed = true;
        return { ...m, key, value };
      });
      rebuilt = changed ? { ...e, superClass, members } : e;
      break;
    }
    case "func": {
      const params = mapParams(e.params, fx);
      const body = mapStmts(e.body, (s) => s, fx);
      rebuilt = params === e.params && body === e.body ? e : { ...e, params, body };
      break;
    }
    case "await": { // F25-1
      const arg = mapExpr(e.arg, fx);
      rebuilt = arg === e.arg ? e : { ...e, arg };
      break;
    }
    case "yield": { // F25-1
      const arg = e.arg === null ? null : mapExpr(e.arg, fx);
      rebuilt = arg === e.arg ? e : { ...e, arg };
      break;
    }
    default:
      rebuilt = e; // ident, lit, this, argumentsObject
  }
  return fx(rebuilt);
}

/** Post-order rebuild of `list`: every `Expr` through `fx`, then every `Stmt`
 *  (including its own rebuilt children) through `fs`. `fx` defaults to the
 *  identity so a rung that only rewrites statements can omit it. */
export function mapStmts(list: readonly Stmt[], fs: (s: Stmt) => Stmt, fx: (e: Expr) => Expr = (e) => e): readonly Stmt[] {
  const out = list.map((s) => fs(mapStmtChildren(s, fs, fx)));
  return out.every((s, i) => s === list[i]) ? list : out;
}

function mapStmtChildren(s: Stmt, fs: (s: Stmt) => Stmt, fx: (e: Expr) => Expr): Stmt {
  switch (s.k) {
    case "expr": {
      const expr = mapExpr(s.expr, fx);
      return expr === s.expr ? s : { ...s, expr };
    }
    case "init": {
      const value = mapExpr(s.value, fx);
      return value === s.value ? s : { ...s, value };
    }
    case "if": {
      const test = mapExpr(s.test, fx);
      const then = mapStmts(s.then, fs, fx);
      const els = mapStmts(s.else, fs, fx);
      return test === s.test && then === s.then && els === s.else ? s : { ...s, test, then, else: els };
    }
    case "while": {
      const test = s.test !== undefined ? mapExpr(s.test, fx) : undefined;
      const body = mapStmts(s.body, fs, fx);
      return test === s.test && body === s.body ? s : { ...s, ...(test !== undefined ? { test } : {}), body };
    }
    case "do-while": {
      const test = mapExpr(s.test, fx);
      const body = mapStmts(s.body, fs, fx);
      return test === s.test && body === s.body ? s : { ...s, test, body };
    }
    case "for": {
      const init = s.init === null ? null : mapExpr(s.init, fx);
      const test = mapExpr(s.test, fx);
      const update = s.update === null ? null : mapExpr(s.update, fx);
      const body = mapStmts(s.body, fs, fx);
      return init === s.init && test === s.test && update === s.update && body === s.body ? s : { ...s, init, test, update, body };
    }
    case "for-in":
    case "for-of": {
      const left = mapExpr(s.left, fx);
      const right = mapExpr(s.right, fx);
      const body = mapStmts(s.body, fs, fx);
      return left === s.left && right === s.right && body === s.body ? s : { ...s, left, right, body };
    }
    case "labeled": {
      const body = mapStmts(s.body, fs, fx);
      return body === s.body ? s : { ...s, body };
    }
    case "return": {
      const arg = s.arg === null ? null : mapExpr(s.arg, fx);
      return arg === s.arg ? s : { ...s, arg };
    }
    case "throw": {
      const arg = mapExpr(s.arg, fx);
      return arg === s.arg ? s : { ...s, arg };
    }
    case "try": {
      const block = mapStmts(s.block, fs, fx);
      const handler = mapStmts(s.handler, fs, fx);
      return block === s.block && handler === s.handler ? s : { ...s, block, handler };
    }
    case "switch": {
      const disc = mapExpr(s.disc, fx);
      let changed = disc !== s.disc;
      const cases = s.cases.map((c) => {
        const test = c.test === null ? null : mapExpr(c.test, fx);
        const body = mapStmts(c.body, fs, fx);
        if (test !== c.test || body !== c.body) changed = true;
        return test === c.test && body === c.body ? c : { ...c, test, body };
      });
      return changed ? { ...s, disc, cases } : s;
    }
    case "classdecl": { // F24-1
      const value = mapExpr(s.value, fx);
      return value === s.value ? s : { ...s, value };
    }
    case "func": {
      const params = mapParams(s.params, fx);
      const body = mapStmts(s.body, fs, fx);
      return params === s.params && body === s.body ? s : { ...s, params, body };
    }
    case "iife": {
      const body = mapStmts(s.body, fs, fx);
      return body === s.body ? s : { ...s, body };
    }
    default:
      return s; // decl, break, continue, directive, comment, raw
  }
}

// ---------------------------------------------------------------------------
// F1 — site enumeration and splice.
// ---------------------------------------------------------------------------

/**
 * Every statement list reachable from `body`, innermost first (post-order),
 * skipping any `k:"func"` statement's or `func` expression's body: both are
 * a separate site, already processed under their own context (`emitOne`
 * recurses child-first). Lists compare by object identity, so the driver's
 * `refused` set works exactly as in stage A.
 */
export function stmtLists(body: readonly Stmt[]): readonly (readonly Stmt[])[] {
  const out: (readonly Stmt[])[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of":
        case "labeled":
        case "iife":
          visit(s.body);
          break;
        case "try":
          visit(s.block);
          visit(s.handler);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break; // "func": a separate site; everything else has no sub-list
      }
    }
    out.push(list);
  };
  visit(body);
  return out;
}

/** Replace `target` (by identity) with `repl`, rebuilding only the spine —
 *  mirrors `driver.ts`'s `splice`, at list granularity. Never descends into a
 *  `func` body: that is a different site's tree. */
export function spliceList(root: readonly Stmt[], target: readonly Stmt[], repl: readonly Stmt[]): readonly Stmt[] {
  if (root === target) return repl;
  let changed = false;
  const next = root.map((s) => {
    const r = spliceInStmt(s, target, repl);
    if (r !== s) changed = true;
    return r;
  });
  return changed ? next : root;
}

function spliceInStmt(s: Stmt, target: readonly Stmt[], repl: readonly Stmt[]): Stmt {
  switch (s.k) {
    case "if": {
      const then = spliceList(s.then, target, repl);
      const els = spliceList(s.else, target, repl);
      return then === s.then && els === s.else ? s : { ...s, then, else: els };
    }
    case "while":
    case "do-while":
    case "for":
    case "for-in":
    case "for-of":
    case "labeled":
    case "iife": {
      const body = spliceList(s.body, target, repl);
      return body === s.body ? s : { ...s, body };
    }
    case "try": {
      const block = spliceList(s.block, target, repl);
      const handler = spliceList(s.handler, target, repl);
      return block === s.block && handler === s.handler ? s : { ...s, block, handler };
    }
    case "switch": {
      let changed = false;
      const cases = s.cases.map((c) => {
        const cbody = spliceList(c.body, target, repl);
        if (cbody !== c.body) changed = true;
        return cbody === c.body ? c : { ...c, body: cbody };
      });
      return changed ? { ...s, cases } : s;
    }
    default:
      return s; // "func": a separate site, never spliced through its parent's list
  }
}

// ---------------------------------------------------------------------------
// Free names / parseability.
// ---------------------------------------------------------------------------

/** Names read or written anywhere in `stmts` (including nested `func`
 *  bodies, since a closure's captures matter to the caller) that are not
 *  themselves declared somewhere in `stmts` — `decl`/`init`/a `func`'s own
 *  name and parameters, or a `catch` binding. A conservative, whole-list
 *  approximation (no block scoping): good enough for "would introducing this
 *  name collide with something already free here", which is what a rung
 *  needs it for. */
export function freeNames(stmts: readonly Stmt[]): Set<string> {
  const used = new Set<string>();
  const bound = new Set<string>();
  walk(stmts, {
    expr: (e) => {
      if (e.k === "ident") used.add(e.name);
      else if (e.k === "func") {
        if (e.name !== null) bound.add(e.name);
        // F15: `param.init`'s idents (walked generically by `walk` below)
        // are free of the *outer* list this func node sits in — only the
        // param's own name is bound here.
        for (const param of e.params) bound.add(param.name);
      }
    },
    stmt: (s) => {
      if (s.k === "decl") for (const n of s.names) bound.add(n);
      else if (s.k === "init") bound.add(s.name);
      else if (s.k === "try") { if (s.param !== null) bound.add(s.param); }
      else if ((s.k === "for-in" || s.k === "for-of") && s.left.k === "ident") bound.add(s.left.name);
      else if (s.k === "func") {
        bound.add(s.name);
        for (const param of s.params) bound.add(param.name);
      }
    },
  });
  for (const b of bound) used.delete(b);
  return used;
}

/** `true` when `stmts`, wrapped in a throwaway function so a bare
 *  `return`/`break`/`continue` is legal, is syntactically valid JavaScript. */
export function parses(stmts: readonly Stmt[]): boolean {
  try {
    const src = printProgram([{ k: "func", name: "_hbc2js_parses_check", params: [], body: stmts }]);
    new vm.Script(src);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Uses of one register/name.
// ---------------------------------------------------------------------------

export interface IdentUses {
  readonly reads: number;
  readonly writes: number;
  /** Uses inside a nested `func` body that are *provably the same binding*
   *  as `name` in this list's own frame — kept separate from `reads`/
   *  `writes`, which count only this list's own frame. Function-scoped: a
   *  `k:"func"` node is always emitted from a genuine Hermes `CreateClosure`
   *  (`src/emit/lower.ts`), i.e. a separate function-table entry with its
   *  own, independently-numbered register file (Hermes restarts `r0` per
   *  function — AGENT-BRIEF). A register name (`isRegisterName`) therefore
   *  can never denote the same binding across that boundary: any real
   *  capture is copied into a lexical environment slot first, named
   *  `_e<env>_<slot>` (`src/emit/names.ts`'s `envSlot`, "collision-free by
   *  construction", keyed by an env id that is never reused the way a
   *  register number is), and *that* name — never the raw register — is
   *  what the nested body actually reads. So an `ident rX` found inside a
   *  nested `func` body is, with certainty, that closure's own distinct
   *  local that happens to land on the same number, not a reference to the
   *  outer frame's `rX`: for a register name, `nested` is always `0`. For
   *  any other name (an env slot, a hoisted var, a free name — all
   *  collision-free across function boundaries by construction) a match
   *  inside a nested body is a genuine cross-scope reference, and `nested`
   *  counts it as such. Querying the nested function's own use of a
   *  same-numbered register is a separate question, answered by calling
   *  `identUses` on that function's own body directly (its own frame is
   *  then this call's top-level scope). */
  readonly nested: number;
}

/** How `name` is used in `stmts`: read, written (the target of an `assign`,
 *  or an `init` declaring it), or reached only through a nested closure —
 *  see `IdentUses.nested` for the function-scope boundary this resolves
 *  register names against. */
export function identUses(stmts: readonly Stmt[], name: string): IdentUses {
  return identUsesMany(stmts, [name]).get(name) ?? { reads: 0, writes: 0, nested: 0 };
}

/**
 * `identUses` for many names in **one** traversal — the same counts, the same
 * function-scope boundary per name (a register name is never followed into a
 * nested `func`; any other name is, and counts there as `nested`). The
 * result has an entry for every name in `names`, zero-filled when absent.
 *
 * Exists because a rung that needs a count for every `_fnN` in a function
 * body (`fn-naming`) would otherwise walk the whole body once per name —
 * on a real bundle's global function that is hundreds of full walks of a
 * multi-megabyte tree per match, which is what made the M5 pipeline ~250x
 * slower than the baseline (docs/PUSHBACK.md P-1). `identUses` itself is
 * the single-name wrapper, so the two can never disagree.
 */
export function identUsesMany(stmts: readonly Stmt[], names: Iterable<string>): Map<string, IdentUses> {
  const wanted = new Set(names);
  // Nested `func` bodies are only worth entering when some wanted name is
  // followed in there (see `IdentUses.nested`): registers are a separate
  // frame, every other name is the same binding.
  let followNested = false;
  for (const n of wanted) if (!isRegisterName(n)) followNested = true;
  const counts = countUses(stmts, (n) => wanted.has(n), followNested);
  for (const n of wanted) if (!counts.has(n)) counts.set(n, { reads: 0, writes: 0, nested: 0 });
  return counts;
}

const registerUsesMemo = new WeakMap<readonly Stmt[], ReadonlyMap<string, IdentUses>>();

/**
 * `identUses` for **every** register name in `stmts` at once (`nested` is
 * always `0`: a register is never followed into a nested `func`), memoised
 * on the list's identity. A register absent from the map has no uses.
 *
 * Sound to memoise because stage-B lists are immutable: a rewrite builds a
 * new list (`spliceList`, every rung's `rewrite`) and never mutates one in
 * place, so a list object's counts can never go stale. This is what lets a
 * rung ask a whole-function question ("is `rX` written exactly once and
 * read exactly here?" — `expr-rebuild`'s D-b) once per driver iteration
 * instead of once per candidate: the driver hands every `match`/`check`
 * call of one iteration the same `ctx.fnBody` object, so all of them share
 * one walk (docs/PUSHBACK.md P-1).
 */
export function registerUses(stmts: readonly Stmt[]): ReadonlyMap<string, IdentUses> {
  let m = registerUsesMemo.get(stmts);
  if (m === undefined) {
    m = countUses(stmts, isRegisterName, false);
    registerUsesMemo.set(stmts, m);
  }
  return m;
}

const ZERO_USES: IdentUses = { reads: 0, writes: 0, nested: 0 };

/**
 * `registerUses(stmts)` **only if it is already memoised** — never a fresh
 * walk, `undefined` otherwise. For a caller that has a second, independent
 * way to answer its question (`expr-rebuild`'s `isDeadAfter`: D-b's
 * whole-function counts *or* a local liveness scan, an `||` of two pure
 * predicates) this is what makes "try the cheap one first" honest: the
 * counts are cheap only when the map has already been paid for, and asking
 * for it unconditionally would turn a bounded scan into a whole-list walk
 * on every site where the scan alone would have sufficed.
 */
export function registerUsesIfMemoised(stmts: readonly Stmt[]): ReadonlyMap<string, IdentUses> | undefined {
  return registerUsesMemo.get(stmts);
}

/**
 * Carry `registerUses` across one already-proven splice, instead of letting
 * the next caller rebuild it from scratch.
 *
 * The caller must have proven, position by position, that `after` is
 * `before` with the window `[lo, hiBefore)` replaced by `[lo, hiAfter)` and
 * every other position unchanged (`expr-rebuild/check.ts`'s
 * `verifyExpectedShape` does exactly that, before calling this).
 * `beforeMid`/`afterMid` are `registerUses` of those two windows — the same
 * two maps `registerUseDelta` needs anyway, so this costs no extra walk.
 *
 * `countUses` is a plain left-to-right accumulation with no cross-statement
 * state, so `registerUses` is concatenative: writing `before = pre ++
 * beforeMid ++ post` and `after = pre ++ afterMid ++ post` for the same
 * `pre`/`post`, `uses(after) = uses(before) - uses(beforeMid) +
 * uses(afterMid)` componentwise, the `pre`/`post` terms cancelling exactly.
 * That is the identity `registerUseDelta` already relies on, applied to
 * every name at once rather than to one register.
 *
 * Cost: `O(distinct register names)` for the shallow map copy plus the two
 * windows the caller already computed — never `O(list.length)`. Without it,
 * every applied site gives the edited list a fresh array identity, so the
 * next driver iteration's `registerUses(ctx.fnBody)` is a cold whole-list
 * walk: a `Theta(sites x list.length)` term worth ~40% of the CPU on a
 * module-root-shaped function (`docs/BUGS.md`'s superlinear-pass row,
 * part 5; `docs/reports/2026-09-05-perf5-match-scan.md`).
 *
 * A no-op when `before`'s own map was never memoised (nothing to derive
 * from) or `after`'s already is. Never mutates a cached entry in place: the
 * shallow copy shares the unchanged names' count objects, and every changed
 * name gets a fresh one.
 */
export function noteRegisterUsesSplice(before: readonly Stmt[], after: readonly Stmt[], beforeMid: ReadonlyMap<string, IdentUses>, afterMid: ReadonlyMap<string, IdentUses>): void {
  const base = registerUsesMemo.get(before);
  if (base === undefined || registerUsesMemo.has(after)) return;
  const next = new Map<string, IdentUses>(base);
  const touched = new Set<string>(beforeMid.keys());
  for (const name of afterMid.keys()) touched.add(name);
  for (const name of touched) {
    const b = base.get(name) ?? ZERO_USES;
    const m = beforeMid.get(name) ?? ZERO_USES;
    const a = afterMid.get(name) ?? ZERO_USES;
    const reads = b.reads - m.reads + a.reads;
    const writes = b.writes - m.writes + a.writes;
    const nested = b.nested - m.nested + a.nested;
    // `countUses` only ever creates an entry when it bumps one, so a cold
    // walk never yields an all-zero entry either — deleting keeps the
    // derived map key-for-key identical to a cold `registerUses(after)`.
    if (reads === 0 && writes === 0 && nested === 0) next.delete(name);
    else next.set(name, { reads, writes, nested });
  }
  registerUsesMemo.set(after, next);
}

/** The one traversal behind `identUses`/`identUsesMany`/`registerUses`:
 *  counts every name `wanted` accepts; enters nested `func` bodies only when
 *  `followNested`, and even then never credits a register name there. */
function countUses(stmts: readonly Stmt[], wanted: (name: string) => boolean, followNested: boolean): Map<string, IdentUses> {
  const counts = new Map<string, { reads: number; writes: number; nested: number }>();
  const bump = (name: string, inNested: boolean, isWrite: boolean): void => {
    if (!wanted(name)) return;
    let c = counts.get(name);
    if (c === undefined) {
      c = { reads: 0, writes: 0, nested: 0 };
      counts.set(name, c);
    }
    if (inNested) {
      if (!isRegisterName(name)) c.nested++;
    } else if (isWrite) c.writes++;
    else c.reads++;
  };
  const visitExpr = (e: Expr, inNested: boolean): void => {
    switch (e.k) {
      case "ident":
        bump(e.name, inNested, false);
        return;
      case "assign":
        if (e.target.k === "ident") bump(e.target.name, inNested, true);
        else visitExpr(e.target, inNested);
        visitExpr(e.value, inNested);
        return;
      case "member":
        visitExpr(e.obj, inNested);
        if (e.computed) visitExpr(e.prop, inNested);
        return;
      case "call":
      case "new":
        visitExpr(e.callee, inNested);
        e.args.forEach((a) => visitExpr(a, inNested));
        return;
      case "bin":
      case "logical":
        visitExpr(e.left, inNested);
        visitExpr(e.right, inNested);
        return;
      case "unary":
        visitExpr(e.arg, inNested);
        return;
      case "cond":
        visitExpr(e.test, inNested);
        visitExpr(e.then, inNested);
        visitExpr(e.else, inNested);
        return;
      case "array":
        e.elements.forEach((x) => visitExpr(x, inNested));
        return;
      case "object":
        e.props.forEach((p) => visitExpr("k" in p ? p.arg : p.value, inNested));
        return;
      case "spread": // F17
        visitExpr(e.arg, inNested);
        return;
      case "seq":
        e.exprs.forEach((x) => visitExpr(x, inNested));
        return;
      case "template": // F14
        e.exprs.forEach((x) => visitExpr(x, inNested));
        return;
      case "tagged": // F14
        visitExpr(e.tag, inNested);
        visitExpr(e.quasi, inNested);
        return;
      case "jsx": // D20
        jsxParts(e).forEach((x) => visitExpr(x, inNested));
        return;
      case "class": // F24-1: a member value is the `func` expression it is.
        classParts(e).forEach((x) => visitExpr(x, inNested));
        for (const m of e.members) if (m.value !== null && m.kind !== "field") visitExpr(m.value, inNested);
        return;
      case "func":
        // `sameFrame` (see `Expr`'s `func` doc, `src/emit/ast.ts`): the
        // generator/async resume closure is not a second Hermes function —
        // it is this frame's own state machine, sharing its registers — so
        // it is transparent to `countUses`: visited with `inNested`
        // unchanged, register names included, exactly like any other
        // statement in this same list.
        if (e.sameFrame === true) {
          for (const param of e.params) if (param.init !== undefined) visitExpr(param.init, inNested);
          visitStmts(e.body, inNested);
          return;
        }
        // Otherwise a separate register frame (see `IdentUses.nested`'s
        // doc): a register name can never be the same binding in there, so
        // skip it entirely rather than let a coincidentally-same-numbered
        // local count as a "nested" use of this frame's `name`. A param
        // default runs in that same nested frame (it is per-call, not
        // per-definition — see `effectSequence`'s `func` case), never this
        // one's, so it follows the exact same rule as the body.
        if (followNested) {
          for (const param of e.params) if (param.init !== undefined) visitExpr(param.init, true);
          visitStmts(e.body, true);
        }
        return;
      default:
        return; // lit, this, argumentsObject
    }
  };
  const visitStmts = (list: readonly Stmt[], inNested: boolean): void => {
    for (const s of list) {
      switch (s.k) {
        case "expr":
          visitExpr(s.expr, inNested);
          break;
        case "init":
          bump(s.name, inNested, true);
          visitExpr(s.value, inNested);
          break;
        case "if":
          visitExpr(s.test, inNested);
          visitStmts(s.then, inNested);
          visitStmts(s.else, inNested);
          break;
        case "while":
          if (s.test !== undefined) visitExpr(s.test, inNested);
          visitStmts(s.body, inNested);
          break;
        case "do-while":
          visitExpr(s.test, inNested);
          visitStmts(s.body, inNested);
          break;
        case "for":
          if (s.init !== null) visitExpr(s.init, inNested);
          visitExpr(s.test, inNested);
          if (s.update !== null) visitExpr(s.update, inNested);
          visitStmts(s.body, inNested);
          break;
        case "for-in":
        case "for-of":
          // `left` is the loop's own binding — a declaration site, same as
          // `init`'s name, not a read of whatever it held before.
          if (s.left.k === "ident") bump(s.left.name, inNested, true);
          else visitExpr(s.left, inNested);
          visitExpr(s.right, inNested);
          visitStmts(s.body, inNested);
          break;
        case "labeled":
          visitStmts(s.body, inNested);
          break;
        case "return":
          if (s.arg !== null) visitExpr(s.arg, inNested);
          break;
        case "throw":
          visitExpr(s.arg, inNested);
          break;
        case "try":
          visitStmts(s.block, inNested);
          visitStmts(s.handler, inNested);
          break;
        case "switch":
          visitExpr(s.disc, inNested);
          for (const c of s.cases) {
            if (c.test !== null) visitExpr(c.test, inNested);
            visitStmts(c.body, inNested);
          }
          break;
        case "classdecl": // F24-1
          visitExpr(s.value, inNested);
          break;
        case "func":
          // Same boundary as the `Expr` "func" case above.
          if (followNested) {
            for (const param of s.params) if (param.init !== undefined) visitExpr(param.init, true);
            visitStmts(s.body, true);
          }
          break;
        case "iife":
          visitStmts(s.body, inNested);
          break;
        default:
          break; // decl, break, continue, directive, comment, raw
      }
    }
  };
  visitStmts(stmts, false);
  return counts;
}

// ---------------------------------------------------------------------------
// def/use over `rN` registers, by pre-order statement index.
// ---------------------------------------------------------------------------

// F15 (docs/specs/passes/19-reg-split.md §3.1): a register name is `rN` or,
// once `reg-split` has split a multi-web register, `rN_j` (`j` >= 2, one
// suffix, the web's 1-based ordinal) — never a second suffix, never on `j`
// alone. Every consumer below (`defUse`/`identUses`/`registerUses`/
// `effectSequence`/the F10 finaliser) already keys off `isRegisterName`, so
// widening this one regex is the pass's entire framework surface: a split
// name is still "just a scratch slot", still frame-local, still dropped by
// F10 when dead.
const REG_RE = /^r\d+(?:_\d+)?$/;

/** `true` for a Hermes register name (`r0`, `r17`, …) or a `reg-split`-made
 *  web variable (`r0_2`, `r17_3`, …) — the only names `defUse`/
 *  `effectSequence` treat as "just a scratch slot" rather than a visible
 *  binding. Exported so `src/passes/index.ts`'s F10 finaliser (which needs
 *  the same test to decide which of a function's leading `decl let r0…rN`
 *  are still live) does not duplicate it. */
export function isRegisterName(name: string): boolean {
  return REG_RE.test(name);
}

export interface DefUse {
  readonly defs: number[];
  readonly reads: number[];
}

/** Shared walk behind `defUse` and `incrementalDefUse` (below): identical
 *  traversal, but the position assigned to each statement comes from
 *  `nextAt(s)` instead of a hardcoded counter, so a caller that needs
 *  positions to survive a splice unrenumbered (persistent keys, not plain
 *  indices) can supply its own generator without duplicating this ~120-line
 *  switch. `nextAt` is called exactly once per statement, in the same
 *  pre-order `defUse`'s doc comment describes. */
function defUseWalk(stmts: readonly Stmt[], nextAt: (s: Stmt) => number): Map<string, DefUse> {
  const out = new Map<string, DefUse>();
  const rec = (name: string, kind: keyof DefUse, at: number): void => {
    if (!isRegisterName(name)) return;
    let e = out.get(name);
    if (e === undefined) {
      e = { defs: [], reads: [] };
      out.set(name, e);
    }
    e[kind].push(at);
  };
  const visitExpr = (e: Expr, at: number): void => {
    switch (e.k) {
      case "ident":
        rec(e.name, "reads", at);
        return;
      case "assign":
        if (e.target.k === "ident") rec(e.target.name, "defs", at);
        else visitExpr(e.target, at);
        visitExpr(e.value, at);
        return;
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
      case "cond":
        visitExpr(e.test, at);
        visitExpr(e.then, at);
        visitExpr(e.else, at);
        return;
      case "array":
        e.elements.forEach((x) => visitExpr(x, at));
        return;
      case "object":
        e.props.forEach((p) => visitExpr("k" in p ? p.arg : p.value, at));
        return;
      case "spread": // F17
        visitExpr(e.arg, at);
        return;
      case "seq":
        e.exprs.forEach((x) => visitExpr(x, at));
        return;
      case "template": // F14
        e.exprs.forEach((x) => visitExpr(x, at));
        return;
      case "tagged": // F14
        visitExpr(e.tag, at);
        visitExpr(e.quasi, at);
        return;
      case "jsx": // D20
        jsxParts(e).forEach((x) => visitExpr(x, at));
        return;
      default:
        return; // lit, this, argumentsObject, func (separate frame)
    }
  };
  const visitStmts = (list: readonly Stmt[]): void => {
    for (const s of list) {
      const at = nextAt(s);
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
        case "for-in":
        case "for-of":
          if (s.left.k === "ident") rec(s.left.name, "defs", at);
          else visitExpr(s.left, at);
          visitExpr(s.right, at);
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

/** `rN` defs/reads only (this is expr-rebuild's register-liveness question,
 *  not a general def/use table) — indexed by the statement's own pre-order
 *  position in `stmts` (nested statements get later indices than the
 *  statement containing them, assigned before recursing into it). A nested
 *  `func`'s own registers belong to a different frame and are not counted. */
export function defUse(stmts: readonly Stmt[]): Map<string, DefUse> {
  let index = 0;
  return defUseWalk(stmts, () => index++);
}

// ---------------------------------------------------------------------------
// Purity.
// ---------------------------------------------------------------------------

/** Literals, idents, `this`, and unary/binary/logical/cond built entirely
 *  from pure operands. Deliberately **not** `member` (getters), `call`,
 *  `new`, or `assign` — those may have side effects a caller must not fold
 *  away or reorder.
 *
 *  Also deliberately **not** pure regardless of operand purity: `in`
 *  (invokes a Proxy's `has` trap on its right operand — D14/§8, the
 *  02-proxy-trap-counting fixture) and `instanceof` (reads `.prototype` off
 *  its right operand, itself a `member` get that can be a Proxy `get` trap,
 *  and may delegate to a user `Symbol.hasInstance`), and unary `delete `
 *  (invokes a Proxy's `deleteProperty` trap). Every one of these can run
 *  arbitrary user code as an observable side effect even though the
 *  expression *looks* like a plain operator to the caller, so a caller must
 *  never fold, reorder past, or drop one just because its result goes
 *  unused — see `expr-rebuild/rewrite.ts`'s R1b dead-store rule, which uses
 *  `isPure` to decide whether it may delete a dead store outright instead of
 *  keeping it as a bare expression statement for its effect. */
export function isPure(e: Expr): boolean {
  switch (e.k) {
    case "lit":
    case "ident":
    case "this":
      return true;
    case "unary":
      return e.op !== "delete " && isPure(e.arg);
    case "bin":
      return e.op !== "in" && e.op !== "instanceof" && isPure(e.left) && isPure(e.right);
    case "logical":
      return isPure(e.left) && isPure(e.right);
    case "cond":
      return isPure(e.test) && isPure(e.then) && isPure(e.else);
    default:
      return false;
  }
}

/** `comment`/`decl` (no value at all), or an `expr` statement that is
 *  exactly an assignment of a pure value to a plain identifier. */
export function isPureStmt(s: Stmt): boolean {
  if (s.k === "comment" || s.k === "decl") return true;
  return s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && isPure(s.expr.value);
}

// ---------------------------------------------------------------------------
// Helper-call recognition, by name, never by position.
// ---------------------------------------------------------------------------

/** `e` is `name(...)` — a call to one of `src/runtime/helpers.ts`'s
 *  `__hbc_*` prelude functions, recognised by the callee's *name*, never by
 *  its position in an expression (a rewrite may have moved it anywhere). */
export function isHelperCall(e: Expr, name: string): e is Expr & { readonly k: "call" } {
  return e.k === "call" && e.callee.k === "ident" && e.callee.name === name;
}

// ---------------------------------------------------------------------------
// Safe identifiers — copied from `src/emit/names.ts` (rungs may not import it).
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

/** A rung may introduce `name` as a plain identifier only if this holds. */
export function isSafeIdentifier(name: string): boolean {
  return IDENT_RE.test(name) && !RESERVED.has(name);
}

// ---------------------------------------------------------------------------
// §4.3 — the ordered effect sequence, and the expression-only check built on it.
// ---------------------------------------------------------------------------

export type Effect =
  | { readonly k: "call"; readonly callee: string; readonly arity: number; readonly guardDepth?: number }
  | { readonly k: "new"; readonly callee: string; readonly arity: number }
  | { readonly k: "member-write" }
  | { readonly k: "member-read"; readonly guardDepth?: number }
  | { readonly k: "delete" }
  | { readonly k: "throw" }
  | { readonly k: "return" }
  | { readonly k: "assign"; readonly name: string }
  /** F25-1 (docs/specs/passes/25-yield-async-recovery.md §2): a `yield`/
   *  `await` suspension. Observable, and never reorderable past anything. */
  | { readonly k: "suspend"; readonly kind: "yield" | "yield*" | "await" };

/**
 * F18 (docs/specs/passes/18-optional-chain.md §3/§6 item 2): how many
 * `?.` guards dominate `e`'s own read/call — the count of guarded links
 * (`optmember`/`optcall`) from `e` back to the chain's base, inclusive of
 * `e` itself. `0` for anything not sitting on top of an `optmember`/
 * `optcall` chain. This is what lets `effectSequence` tell "the getter ran
 * unconditionally" from "the getter ran behind one/two nullish checks" —
 * two effect sequences that are otherwise identical in order and shape but
 * differ in exactly this are *not* the same program (D14).
 */
function chainGuardDepth(e: Expr): number {
  switch (e.k) {
    case "optmember":
      return chainGuardDepth(e.obj) + 1;
    case "optcall":
      return chainGuardDepth(e.callee) + 1;
    case "member":
      return chainGuardDepth(e.obj);
    case "call":
      return chainGuardDepth(e.callee);
    default:
      return 0;
  }
}

/** A callee's shape for effect comparison: the property name for a member
 *  callee (the part that decides *what* gets called), the bare node kind
 *  otherwise — deliberately coarse, since a rewrite may fold `r5` into the
 *  expression that computed it without changing what is actually invoked. */
function calleeShape(e: Expr): string {
  return e.k === "member" || e.k === "optmember" ? (e.computed ? "member[computed]" : `member.${(e.prop as { readonly text: string }).text}`) : e.k;
}

/**
 * The ordered, observable effects of `stmts`: every `call`/`new` (by callee
 * shape + arity), every member write and every member **read**, `delete`,
 * `throw`, `return`, and an assignment to a non-`rN` name. A plain scratch
 * register's reassignment is never observable outside this list: the moment
 * a nested closure genuinely captures a value, that capture is itself an
 * assignment to a lexical environment slot (`_e<env>_<slot>`, never a raw
 * `rN` — see `IdentUses.nested`'s doc), which is a non-register name and so
 * already counts as an effect on its own; a register name can never *also*
 * be "the same binding a closure captured" (`identUses(...).nested` is
 * always `0` for one), so there is nothing further for this function to
 * detect through the register name itself. This is the whole guard an
 * expression-only stage-B rewrite gets: reorder or drop nothing here, and it
 * may do anything else it likes to how a value gets computed.
 */
export function effectSequence(stmts: readonly Stmt[]): readonly Effect[] {
  const out: Effect[] = [];
  const isVisible = (name: string): boolean => !isRegisterName(name);
  // F18: only a guarded effect (one sitting on top of an `optmember`/
  // `optcall` chain) carries `guardDepth` at all — omitted (not `0`) for
  // everything else, so every effect-sequence literal predating F18 (and
  // every fixture with no `?.` in it) is untouched byte-for-byte.
  const withDepth = <T extends { readonly k: "call" | "member-read" }>(effect: T, e: Expr): T => {
    const d = chainGuardDepth(e);
    return d > 0 ? { ...effect, guardDepth: d } : effect;
  };
  const visitExpr = (e: Expr): void => {
    switch (e.k) {
      case "call":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        out.push(withDepth({ k: "call", callee: calleeShape(e.callee), arity: e.args.length }, e));
        return;
      case "optcall": // F18: the args sit *inside* the guard — never evaluated when the callee is nullish.
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        out.push(withDepth({ k: "call", callee: calleeShape(e.callee), arity: e.args.length }, e));
        return;
      case "new":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        out.push({ k: "new", callee: calleeShape(e.callee), arity: e.args.length });
        return;
      case "member":
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        out.push(withDepth({ k: "member-read" }, e));
        return;
      case "optmember": // F18
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        out.push(withDepth({ k: "member-read" }, e));
        return;
      case "class":
        // F24-1. Defining a class evaluates its `extends` expression, its
        // computed keys and its field initialisers, in that order, and
        // nothing else -- a method body is not run. The own-property
        // definitions the class performs are exactly the ones the
        // `class-recover` rung declares it deleted, so they are accounted for
        // by that rung's class-shape checker (spec 24 section 3.4), not here.
        classParts(e).forEach(visitExpr);
        return;
      case "await": // F25-1: a suspension is observable and never reorderable.
        visitExpr(e.arg);
        out.push({ k: "suspend", kind: "await" });
        return;
      case "yield": // F25-1
        if (e.arg !== null) visitExpr(e.arg);
        out.push({ k: "suspend", kind: e.delegate ? "yield*" : "yield" });
        return;
      case "unary":
        // `delete o.p` does not itself *read* `p` (unlike every other
        // appearance of a `member` node) — only `o` is evaluated.
        if (e.op === "delete " && e.arg.k === "member") {
          visitExpr(e.arg.obj);
          if (e.arg.computed) visitExpr(e.arg.prop);
          out.push({ k: "delete" });
        } else {
          visitExpr(e.arg);
          if (e.op === "delete ") out.push({ k: "delete" });
        }
        return;
      case "assign":
        if (e.target.k === "member") {
          visitExpr(e.target.obj);
          if (e.target.computed) visitExpr(e.target.prop);
          visitExpr(e.value);
          out.push({ k: "member-write" });
        } else if (e.target.k === "ident") {
          visitExpr(e.value);
          if (isVisible(e.target.name)) out.push({ k: "assign", name: e.target.name });
        } else {
          visitExpr(e.target);
          visitExpr(e.value);
        }
        return;
      case "bin":
      case "logical":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "cond":
        visitExpr(e.test);
        visitExpr(e.then);
        visitExpr(e.else);
        return;
      case "array":
        e.elements.forEach(visitExpr);
        return;
      case "object":
        e.props.forEach((p) => {
          if ("k" in p) {
            visitExpr(p.arg);
            out.push({ k: "call", callee: "<spread>", arity: 1 });
          } else visitExpr(p.value);
        });
        return;
      case "spread":
        // F17: `...arg` iterates `arg` (Symbol.iterator/getters — real user
        // code), the same "calls-with-iteration" treatment §6 item 1's
        // canonical `expand()` gives the underlying helper call it stands
        // for; a generic walker that dropped this would see a rewritten
        // spread site as a no-op.
        visitExpr(e.arg);
        out.push({ k: "call", callee: "<spread>", arity: 1 });
        return;
      case "seq":
        e.exprs.forEach(visitExpr);
        return;
      case "template":
        // F14 (docs/specs/passes/14-template-literal.md §3): a template is
        // its substitutions, in order — ToString on each is what the
        // `HermesInternal.concat` it replaced did too.
        e.exprs.forEach(visitExpr);
        return;
      case "tagged": {
        // F14: `tag`q0${e0}…`` is *the same call* the untagged lowering made
        // — `tag(templateObject, e0, …)` — so it records the same `(callee
        // shape, argc)` entry, `argc` counting the template object. Without
        // this line a rewritten site would look like a dropped call to every
        // later expression-only checker.
        visitExpr(e.tag);
        const subs = e.quasi.k === "template" ? e.quasi.exprs : [];
        subs.forEach(visitExpr);
        out.push({ k: "call", callee: calleeShape(e.tag), arity: subs.length + 1 });
        return;
      }
      case "jsx":
        // D20: a JSX element *is* its element-creation call — same effects,
        // same order, same `(callee shape, argc)` entry.
        visitExpr(jsxToCall(e));
        return;
      case "destructure": {
        // F16 §3: the `destructure` rung's own checker never uses this
        // generic path (it recomputes an exact `expand()` and diffs that
        // through `effectSequence` instead — the real soundness proof); this
        // case exists so a *later* pass, diffing a range that still contains
        // a live destructure statement, does not see it as a no-op. Source,
        // then each pattern default's own effects in pattern order, then one
        // opaque effect for the destructuring itself (iterator protocol /
        // property reads / possible throws are real effects).
        visitExpr(e.source);
        walkPattern(e.pattern, visitExpr);
        out.push({ k: "call", callee: "<destructure>", arity: 0 });
        return;
      }
      default:
        return; // ident, lit, this, argumentsObject, func (its own frame)
    }
  };
  const visitStmts = (list: readonly Stmt[]): void => {
    for (const s of list) {
      switch (s.k) {
        case "expr":
          visitExpr(s.expr);
          break;
        case "init":
          visitExpr(s.value);
          if (isVisible(s.name)) out.push({ k: "assign", name: s.name });
          break;
        case "if":
          visitExpr(s.test);
          visitStmts(s.then);
          visitStmts(s.else);
          break;
        case "while":
          if (s.test !== undefined) visitExpr(s.test);
          visitStmts(s.body);
          break;
        case "do-while":
          visitExpr(s.test);
          visitStmts(s.body);
          break;
        case "for":
          if (s.init !== null) visitExpr(s.init);
          visitExpr(s.test);
          if (s.update !== null) visitExpr(s.update);
          visitStmts(s.body);
          break;
        case "for-in":
        case "for-of":
          visitExpr(s.right);
          if (s.left.k === "ident" && isVisible(s.left.name)) out.push({ k: "assign", name: s.left.name });
          visitStmts(s.body);
          break;
        case "labeled":
          visitStmts(s.body);
          break;
        case "return":
          if (s.arg !== null) visitExpr(s.arg);
          out.push({ k: "return" });
          break;
        case "throw":
          visitExpr(s.arg);
          out.push({ k: "throw" });
          break;
        case "try":
          visitStmts(s.block);
          visitStmts(s.handler);
          break;
        case "switch":
          visitExpr(s.disc);
          for (const c of s.cases) {
            if (c.test !== null) visitExpr(c.test);
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

// `expressionOnlyCheck`'s read-before-def half only ever asks "is read
// position A before def position B" — any strictly order-preserving
// relabelling of statements answers that identically to real pre-order
// indices, so this private cache keys statements by a *persistent* float
// instead of `defUse`'s plain index: a statement kept by a rewrite (the
// reference-equal prefix/suffix below, the same split the effect-sequence
// half already computes) keeps the exact same key forever; only the
// handful of statements a splice actually replaces get a fresh key,
// interpolated strictly between their new neighbours. That turns
// "recompute def/use for the whole list every applied site" into
// "recompute it for the changed region, look up the unchanged region's
// positions from the last time they were computed" — `O(changed region)`
// amortised, not `O(list length)`, mirroring the effect-sequence half's own
// prefix/suffix trick one function down, extended with persistent state
// because (architecture sweep finding 1) unlike effects this check is a
// genuinely global property: whether a read is "before" a def depends on
// the *whole* list's order, not just the changed region's own order —
// hence "needs a global position; needs incremental state" in the QUEUE
// item this fixes. `defUse` itself (several other passes call it directly
// for real pre-order indices) is untouched; this cache is private to this
// one check.
// A single statement object can be visited by *more than one* independent
// numbering space: `stmtLists` yields every nested statement list as its
// own site (a function's top-level body *and* separately an `if`'s `then`
// body, say), and `defUse`'s positions are only meaningful relative to
// whichever `stmts` argument started that particular walk — a nested
// statement gets a different number as part of the enclosing list's walk
// than it gets when its own containing list is walked on its own. So the
// persistent key map must be scoped per numbering-space ("lineage"), not
// global by statement identity — a global `WeakMap<Stmt, number>` here
// would silently let an unrelated list's numbering clobber this one's the
// first time the two walks ever shared a statement object, which is
// exactly what `expression-only-check-differential.test.ts` caught before
// this fix landed. Each lineage's `posOf` is created once, at that
// lineage's first ("cold") call, and threaded forward by object identity
// through `keyedDefUseCache` exactly as `defUseCache`'s `Map<string,
// DefUse>` already is (`before` at generation *n*+1 is always literally the
// same array `after` was at generation *n* — `spliceList`'s `root===target`
// case returns `repl` unchanged — so a `WeakMap` keyed by list identity
// finds the previous generation's entry every time except the true start
// of a lineage).
// A name can be "read before its own first def" in `after` for a reason
// that has *nothing* to do with the current splice: register reuse (the
// same `rN` read for one purpose, then redefined later for an unrelated
// one) is a normal, harmless shape in lowered bytecode, but `defUse`'s
// "no read before the name's first def *in this list*" rule (deliberately
// conservative — it has no way to tell "harmless reuse" from "a rewrite
// broke evaluation order" apart) flags it anyway, every single time the
// *whole list* is scanned — which the original `defUse(after)` walk did on
// *every* call, so a name like this stays flagged for the entire lifetime
// of the list even though no rewrite ever touches either of its two
// occurrences. An incremental check must reproduce that "still flagged,
// forever, until something finally touches it" behaviour exactly, not just
// "is a name violating *because of this splice*" — `violating` below is
// that persistent set, carried forward by construction (a name's violation
// status among its own occurrences cannot change unless at least one of
// those occurrences sits in the touched region — proved in
// `incrementalReadBeforeDef`'s comment).
interface KeyedEntry {
  readonly du: Map<string, DefUse>;
  readonly posOf: WeakMap<Stmt, number>;
  readonly violating: ReadonlySet<string>;
}
const keyedDefUseCache = new WeakMap<readonly Stmt[], KeyedEntry>();
const KEY_GAP = 2 ** 20; // interpolation headroom; see the degenerate guard below

function isViolating({ defs, reads }: DefUse): boolean {
  if (defs.length === 0) return false; // read-only in this list: defined earlier, outside it
  const firstDef = Math.min(...defs);
  return reads.some((r) => r < firstDef);
}

function allViolations(du: Map<string, DefUse>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, entry] of du) if (isViolating(entry)) out.add(name);
  return out;
}

function coldKeyedDefUse(list: readonly Stmt[]): KeyedEntry {
  const posOf = new WeakMap<Stmt, number>();
  let k = 0;
  const du = defUseWalk(list, (s) => {
    const key = k;
    k += KEY_GAP;
    posOf.set(s, key);
    return key;
  });
  const entry: KeyedEntry = { du, posOf, violating: allViolations(du) };
  keyedDefUseCache.set(list, entry);
  return entry;
}

/** Just the presence of each register name in `list` (no positions needed —
 *  callers only use the key set), for finding which names the *replaced*
 *  middle region (`before`'s side of the splice) used to touch. Bounded by
 *  the same "one pass site's own splice touches a small sub-range"
 *  assumption `expressionOnlyCheck` already relies on for the effect
 *  sequence, so this is `O(changed region)`, not `O(list length)`. */
function namesTouching(list: readonly Stmt[]): ReadonlySet<string> {
  return new Set(defUseWalk(list, () => 0).keys());
}

/** Incremental version of `for (const [name, {defs, reads}] of
 *  defUse(after)) …` — returns the first offending register name, or
 *  `null`. `head`/`tailBefore`/`tailAfter` are the reference-equal split
 *  points `expressionOnlyCheck` already found for the effect-sequence half. */
function incrementalReadBeforeDef(before: readonly Stmt[], after: readonly Stmt[], head: number, tailBefore: number, tailAfter: number): string | null {
  const { du: duBefore, posOf, violating: violatingBefore } = keyedDefUseCache.get(before) ?? coldKeyedDefUse(before);

  // `aKey` is deliberately `posOf(before[head])` — the *old* mid region's
  // own first statement, about to be discarded — not `posOf(before[head -
  // 1])` (the last unchanged statement itself). `defUseWalk`'s positions are
  // full pre-order, recursing into a statement's own nested bodies before
  // moving to its next sibling, so a top-level statement's *own* key is
  // smaller than everything in its own subtree; using it as the head/mid
  // boundary silently dropped every nested def/use inside the last
  // unchanged statement's own body into neither bucket (the differential
  // test caught this: a `labeled`/`if` block right before the splice point
  // lost its own `rN` reads). `before[head]` (old mid's first statement) is
  // guaranteed a bigger key than *all* of `before[head - 1]`'s subtree (the
  // walk only reaches it after finishing that whole subtree) and is
  // strictly less than everything from `before[tailBefore]` on, so it is
  // exactly the exclusive upper bound "head" needs — regardless of how
  // deeply nested `before[head - 1]` is. When `head === before.length`
  // there is no such statement (the splice is a pure append with nothing
  // after it in `before`); that one rare shape falls back to a full
  // recompute below rather than inventing a bound.
  const aKey = head < before.length ? posOf.get(before[head]!) : undefined;
  const bKey = tailAfter < after.length ? posOf.get(after[tailAfter]!) : undefined;
  // Every referenced statement is reference-shared with `before`, so its key
  // was assigned no later than `before` was itself cached (same lineage's
  // `posOf`). Defensive fallback (should be unreachable) if that invariant
  // is ever violated, and the honest fallback for the rare pure-append edge
  // case above.
  if ((head < before.length && aKey === undefined) || (tailAfter < after.length && bKey === undefined)) {
    const cold = coldKeyedDefUse(after);
    return firstOf(cold.violating);
  }

  let prev = aKey;
  let degenerate = false;
  const afterMid = after.slice(head, tailAfter);
  const midDu = defUseWalk(afterMid, (s) => {
    const key = bKey === undefined ? (prev ?? -KEY_GAP) + KEY_GAP : prev === undefined ? bKey - KEY_GAP / 2 : (prev + bKey) / 2;
    if (key === prev || key === bKey) degenerate = true; // float precision exhausted (astronomically rare)
    prev = key;
    posOf.set(s, key); // same lineage: append-only, never overwrites an existing statement's key
    return key;
  });
  if (degenerate) {
    // Thousands of splices landing in the exact same gap: drop the cached
    // lineage and pay one full recompute, same as a cold call for a fresh
    // list — always sound, just not `O(changed region)` this one time.
    const cold = coldKeyedDefUse(after);
    return firstOf(cold.violating);
  }

  const touched = new Set<string>(midDu.keys());
  for (const name of namesTouching(before.slice(head, tailBefore))) touched.add(name);

  const merged = new Map<string, DefUse>(duBefore); // shallow: O(distinct names), not O(list length)
  for (const name of touched) {
    const bef = duBefore.get(name);
    const mid = midDu.get(name);
    const headDefs = aKey === undefined || bef === undefined ? [] : bef.defs.filter((k) => k < aKey);
    const headReads = aKey === undefined || bef === undefined ? [] : bef.reads.filter((k) => k < aKey);
    const tailDefs = bKey === undefined || bef === undefined ? [] : bef.defs.filter((k) => k >= bKey);
    const tailReads = bKey === undefined || bef === undefined ? [] : bef.reads.filter((k) => k >= bKey);
    const defs = [...headDefs, ...(mid?.defs ?? []), ...tailDefs];
    const reads = [...headReads, ...(mid?.reads ?? []), ...tailReads];
    if (defs.length === 0 && reads.length === 0) merged.delete(name);
    else merged.set(name, { defs, reads });
  }

  // `violating(after) = (violating(before) \ touched) ∪ {touched names that
  // are themselves violating in `merged`}` — a name's violation status
  // among its own occurrences only depends on the relative order of those
  // occurrences; an untouched name's occurrences are every one either in
  // `head` (unchanged, same order as `before`) or in `tail` (unchanged
  // *and* shifted together, so their order relative to each other and to
  // `head` is preserved), so its status cannot change. A touched name's
  // status is recomputed fresh above regardless of what it used to be.
  const violating = new Set<string>();
  for (const name of violatingBefore) if (!touched.has(name)) violating.add(name);
  for (const name of touched) {
    const entry = merged.get(name);
    if (entry !== undefined && isViolating(entry)) violating.add(name);
  }
  keyedDefUseCache.set(after, { du: merged, posOf, violating }); // same lineage: `posOf` is carried forward, not copied
  return firstOf(violating);
}

function firstOf(names: ReadonlySet<string>): string | null {
  for (const name of names) return name;
  return null;
}

/** The naive `defUse(after)` loop `expressionOnlyCheck`'s read-before-def
 *  half used before this file's incrementalisation (QUEUE "Perf part 3") —
 *  kept only as `incrementalReadBeforeDef`'s reference implementation for
 *  `tests/gate/passes/expression-only-check-differential.test.ts`, which
 *  runs both side by side over the whole construct-fixture corpus (real
 *  pipeline, real applied sites, `_expressionOnlyCheckDiffProbe` below) and
 *  asserts identical verdicts. Never called on the hot path. */
function readBeforeDefBruteForceReference(after: readonly Stmt[]): string | null {
  for (const [name, { defs, reads }] of defUse(after)) {
    if (defs.length === 0) continue;
    const firstDef = Math.min(...defs);
    if (reads.some((r) => r < firstDef)) return name;
  }
  return null;
}

/** Test-only hook: when set, `expressionOnlyCheck` also runs
 *  `readBeforeDefBruteForceReference` on every call and reports both
 *  verdicts here. `null` (the default) costs one pointer check per call and
 *  changes no behaviour. */
export let _expressionOnlyCheckDiffProbe: ((before: readonly Stmt[], after: readonly Stmt[], oldVerdict: string | null, newVerdict: string | null) => void) | null = null;

export function _setExpressionOnlyCheckDiffProbeForTests(probe: typeof _expressionOnlyCheckDiffProbe): void {
  _expressionOnlyCheckDiffProbe = probe;
}

/** §4.3's expression-only `check`: the effect sequence is unchanged, and no
 *  `rN` in `after` is read before its own first def in `after` (a rewrite
 *  must not read a register earlier than the point it is actually computed). */
export function expressionOnlyCheck(before: readonly Stmt[], after: readonly Stmt[]): CheckResult {
  // `effectSequence` is concatenative (`visitStmts` is a plain left-to-right
  // walk with no state carried between statements), so
  // `effectSequence(before) === effects(before[0,h)) ++ effects(before[h,tb))
  // ++ effects(before[tb,end))`, and identically for `after` with the same
  // split points. A rewrite from this framework only ever touches a small
  // sub-range of `before` (one pass site's own splice) and leaves every
  // other statement the exact same object, so stripping the reference-equal
  // (by construction, unchanged) prefix and suffix first and comparing only
  // the differing middle is the exact same result as comparing the whole
  // list — never a looser check — for `O(changed region)` instead of
  // `O(list.length)` per check. A real bundle's module-root function can be
  // thousands of statements long with a check running per applied site;
  // before this the whole list's effect sequence (and its `JSON.stringify`)
  // was rebuilt from scratch every time (`docs/BUGS.md`'s superlinear-pass
  // row).
  let head = 0;
  const minLen = Math.min(before.length, after.length);
  while (head < minLen && before[head] === after[head]) head++;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }
  const eb = JSON.stringify(effectSequence(before.slice(head, tailBefore)));
  const ea = JSON.stringify(effectSequence(after.slice(head, tailAfter)));
  if (eb !== ea) return { ok: false, reason: "the rewrite changed the observable effect sequence" };
  const violation = incrementalReadBeforeDef(before, after, head, tailBefore, tailAfter);
  if (_expressionOnlyCheckDiffProbe !== null) _expressionOnlyCheckDiffProbe(before, after, readBeforeDefBruteForceReference(after), violation);
  if (violation !== null) return { ok: false, reason: `${violation} is read before its first def in the rewrite` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// F1 — the stage-B driver.
// ---------------------------------------------------------------------------

export interface AstApplyResult {
  readonly body: readonly Stmt[];
  readonly applied: readonly AppliedRecord[];
  readonly abandoned: readonly AbandonedRecord[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Mirrors `driver.ts`'s `MAX_SITES_PER_PASS`: the real backstop behind "a
 *  refused site is never retried" for a matcher that keeps matching. */
const MAX_SITES_PER_PASS = 10_000;

type StmtListPass = Pass<readonly Stmt[]>;

/**
 * One pass at a time, innermost statement list first, until the pass stops
 * matching. Per site, only the rung's own `check` guards it (the stage-A
 * per-site round-trip is too expensive at this granularity); once per
 * (pass, function), after that pass's sites are exhausted, `parses` is the
 * whole-function guard — on failure this pass's work on this function is
 * reverted (not just abandoned site-by-site) and one `W_PASS_ABANDONED`
 * fires with reason `"whole-function parse failed"`.
 */
export function applyAstPasses(fnBody: readonly Stmt[], passes: readonly StmtListPass[], base: Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody">): AstApplyResult {
  const applied: AppliedRecord[] = [];
  const abandoned: AbandonedRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const appliedNames: string[] = [];
  let current = fnBody;

  for (const pass of passes) {
    const beforePass = current;
    const appliedCountBefore = applied.length;
    const refused = new Set<readonly Stmt[]>();
    // W_PASS_REFUSED (mirrors driver.ts): distinct (reason -> site
    // identities) this pass has reported refusing for the current function.
    const refusals = new Map<string, Set<unknown>>();
    const refuse = (node: unknown, reason: string): void => {
      let sites = refusals.get(reason);
      if (sites === undefined) refusals.set(reason, (sites = new Set()));
      sites.add(node);
    };
    let firedHere = false;
    for (let guard = 0; guard < MAX_SITES_PER_PASS; guard++) {
      const ctx: PassContext = { ...base, applied: appliedNames, fnBody: current, refuse };
      const site = firstAstMatch(current, pass, ctx, refused);
      if (site === null) break;
      const { list, match } = site;
      let after: readonly Stmt[];
      let verdict: CheckResult;
      try {
        after = pass.rewrite(match, ctx);
        verdict = pass.check(list, after, ctx);
      } catch (e) {
        throw new Hbc2jsError(ErrorCode.E_PASS_CRASH, `pass "${pass.name}" threw at fn#${match.at.functionIndex} @${match.at.offset}: ${e instanceof Error ? e.message : String(e)}`, { functionIndex: match.at.functionIndex, section: "passes" });
      }
      if (!verdict.ok) {
        refused.add(list);
        abandoned.push({ pass: pass.name, at: match.at, reason: verdict.reason ?? "check failed" });
        continue;
      }
      current = spliceList(current, list, after);
      applied.push({ pass: pass.name, at: match.at });
      firedHere = true;
    }
    for (const [reason, sites] of refusals) {
      diagnostics.push({ severity: "info", code: "W_PASS_REFUSED", message: `pass ${pass.name} refused ${sites.size} site(s): ${reason}`, context: { pass: pass.name, reason, count: sites.size } });
    }
    if (!firedHere) continue;
    if (parses(current)) {
      appliedNames.push(pass.name);
      continue;
    }
    // Whole-function guard failed: revert every site this pass accepted on
    // this function, and record one abandonment in their place.
    const lastOffset = applied[applied.length - 1]?.at.offset ?? 0;
    applied.length = appliedCountBefore;
    current = beforePass;
    abandoned.push({ pass: pass.name, at: { functionIndex: base.functionIndex, offset: lastOffset }, reason: "whole-function parse failed" });
  }
  for (const a of abandoned) {
    diagnostics.push({ severity: "info", code: "W_PASS_ABANDONED", message: `pass ${a.pass} left fn#${a.at.functionIndex} @${a.at.offset} as is: ${a.reason}`, context: { functionIndex: a.at.functionIndex, offset: a.at.offset } });
  }
  return { body: current, applied, abandoned, diagnostics };
}

function firstAstMatch(fnBody: readonly Stmt[], pass: StmtListPass, ctx: PassContext, refused: ReadonlySet<readonly Stmt[]>): { list: readonly Stmt[]; match: NonNullable<ReturnType<StmtListPass["match"]>> } | null {
  for (const list of stmtLists(fnBody)) {
    if (refused.has(list)) continue;
    let m: ReturnType<StmtListPass["match"]>;
    try {
      m = pass.match(list, ctx);
    } catch (e) {
      throw new Hbc2jsError(ErrorCode.E_PASS_CRASH, `pass "${pass.name}" threw in match: ${e instanceof Error ? e.message : String(e)}`, { functionIndex: ctx.functionIndex, section: "passes" });
    }
    if (m !== null) return { list, match: m };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bytecode provenance for a stage-B statement (spec
// `docs/specs/passes/20-object-literal.md` §4). Two Hermes opcodes with
// different semantics can lower to the *same* JS AST node — `PutNewOwnById`
// (an own-property define) and `PutById` (a full [[Set]] that walks the
// prototype chain) both print as `o.k = v` — so a rung that may only fire on
// one of them has to ask which instruction the statement came from. That
// answer lives in the emitter's `Origin` stamp plus the function's CFG, both
// of which are framework, not pass, territory (D12a).
import type { FunctionCfg } from "../cfg/types.ts";
import { originOf as emitOriginOf } from "../emit/origin.ts";
export type { Origin } from "../emit/ast.ts";
export type { ObjectProp, SpreadProp } from "../emit/ast.ts";

/** The bytecode origin recorded on a statement by the emitter, if any.
 *  Absent for a statement no single instruction produced (spec 05 §16). */
export const originOf = emitOriginOf;

const OPCODE_INDEX = new WeakMap<FunctionCfg, ReadonlyMap<number, string>>();

/** Opcode name of the instruction at function-relative byte `offset`, or
 *  `null` when no instruction starts there. Memoised per `FunctionCfg`: the
 *  index is built once and reused by every site of every rung. */
export function opcodeAt(cfg: FunctionCfg, offset: number): string | null {
  let index = OPCODE_INDEX.get(cfg);
  if (index === undefined) {
    const m = new Map<number, string>();
    for (const b of cfg.blocks) for (const insn of b.instructions) m.set(insn.offset, insn.name);
    index = m;
    OPCODE_INDEX.set(cfg, index);
  }
  return index.get(offset) ?? null;
}

/**
 * F24-2 (docs/specs/passes/24-class-recover.md section 2): class-creation
 * *provenance*, read straight off the instruction the emitter stamped on the
 * statement. Shape alone cannot tell a real class from an ES5-transpiled one
 * (spec 24 sections 1.5 and 1.8) -- both are `Object.defineProperty` on a
 * `.prototype` -- so the `class-recover` rung keys on this and nothing else.
 * `null` when no `CreateBaseClass`/`CreateDerivedClass` starts at `offset`.
 */
export interface ClassSite {
  readonly derived: boolean;
  /** Operand 0: the register the constructor value lands in. */
  readonly ctorReg: number;
  /** Operand 1: the register the prototype object lands in. Equal to
   *  `ctorReg` when hermesc aliased them (spec 24 section 1.4 / F24-3). */
  readonly protoReg: number;
  /** Derived form only: the register holding the superclass value. */
  readonly superReg: number | null;
  /** The function-table index of the constructor. */
  readonly ctorFnIdx: number;
  readonly offset: number;
}

const CLASS_SITE_INDEX = new WeakMap<FunctionCfg, ReadonlyMap<number, ClassSite>>();

export function classSiteAt(cfg: FunctionCfg, offset: number): ClassSite | null {
  let index = CLASS_SITE_INDEX.get(cfg);
  if (index === undefined) {
    const m = new Map<number, ClassSite>();
    for (const b of cfg.blocks) {
      for (const insn of b.instructions) {
        const derived = insn.name === "CreateDerivedClass" || insn.name === "CreateDerivedClassLongIndex";
        const base = insn.name === "CreateBaseClass" || insn.name === "CreateBaseClassLongIndex";
        if (!derived && !base) continue;
        // Operand layout (src/emit/lower.ts): base is
        // `dst_ctor, dst_prototype, env, fnIdx`; derived inserts the
        // superclass register before the function index.
        const ops = insn.operands.map((o) => o.value as number);
        m.set(insn.offset, {
          derived,
          ctorReg: ops[0]!,
          protoReg: ops[1]!,
          superReg: derived ? ops[3]! : null,
          ctorFnIdx: derived ? ops[4]! : ops[3]!,
          offset: insn.offset,
        });
      }
    }
    index = m;
    CLASS_SITE_INDEX.set(cfg, index);
  }
  return index.get(offset) ?? null;
}
