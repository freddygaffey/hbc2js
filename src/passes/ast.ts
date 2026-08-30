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
import type { Expr, Stmt } from "../emit/ast.ts";
import { printProgram } from "../emit/print.ts";
import type { AbandonedRecord, AppliedRecord, CheckResult, Pass, PassContext } from "./types.ts";

// F8 gap (spec `docs/specs/passes/02-expr-rebuild.md`): a stage-B rung's
// `match`/`rewrite`/`check` signatures need to *name* `Stmt`/`Expr`, and
// `../../emit/ast.ts` is not on D12a's allowlist — only `../ast.ts` (this
// file) is. Without this re-export no stage-B rung could be typed at all.
export type { Expr, Stmt } from "../emit/ast.ts";

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
        walkExpr(e.obj);
        walkExpr(e.prop);
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
      case "func":
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
        case "func":
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

/** Post-order rebuild of every `Expr` reachable from `e` (including nested
 *  `func` bodies), then `fx` on `e` itself. Only wraps a node in a new object
 *  when a child actually changed, so an untouched subtree keeps its identity. */
export function mapExpr(e: Expr, fx: (e: Expr) => Expr): Expr {
  let rebuilt: Expr;
  switch (e.k) {
    case "member": {
      const obj = mapExpr(e.obj, fx);
      const prop = mapExpr(e.prop, fx);
      rebuilt = obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
      break;
    }
    case "call":
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
        const value = mapExpr(p.value, fx);
        if (value !== p.value) changed = true;
        return value === p.value ? p : { ...p, value };
      });
      rebuilt = changed ? { ...e, props } : e;
      break;
    }
    case "seq": {
      const exprs = e.exprs.map((x) => mapExpr(x, fx));
      rebuilt = exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
      break;
    }
    case "func": {
      const body = mapStmts(e.body, (s) => s, fx);
      rebuilt = body === e.body ? e : { ...e, body };
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
    case "func": {
      const body = mapStmts(s.body, fs, fx);
      return body === s.body ? s : { ...s, body };
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
        for (const p of e.params) bound.add(p);
      }
    },
    stmt: (s) => {
      if (s.k === "decl") for (const n of s.names) bound.add(n);
      else if (s.k === "init") bound.add(s.name);
      else if (s.k === "try") bound.add(s.param);
      else if (s.k === "func") {
        bound.add(s.name);
        for (const p of s.params) bound.add(p);
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
  /** Uses inside a nested `func` body — kept separate from `reads`/`writes`,
   *  which count only this list's own frame. */
  readonly nested: number;
}

/** How `name` is used in `stmts`: read, written (the target of an `assign`,
 *  or an `init` declaring it), or reached only through a nested closure. */
export function identUses(stmts: readonly Stmt[], name: string): IdentUses {
  let reads = 0;
  let writes = 0;
  let nested = 0;
  const bump = (inNested: boolean, isWrite: boolean): void => {
    if (inNested) nested++;
    else if (isWrite) writes++;
    else reads++;
  };
  const visitExpr = (e: Expr, inNested: boolean): void => {
    switch (e.k) {
      case "ident":
        if (e.name === name) bump(inNested, false);
        return;
      case "assign":
        if (e.target.k === "ident" && e.target.name === name) bump(inNested, true);
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
        e.props.forEach((p) => visitExpr(p.value, inNested));
        return;
      case "seq":
        e.exprs.forEach((x) => visitExpr(x, inNested));
        return;
      case "func":
        visitStmts(e.body, true);
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
          if (s.name === name) bump(inNested, true);
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
        case "func":
          visitStmts(s.body, true);
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
  return { reads, writes, nested };
}

// ---------------------------------------------------------------------------
// def/use over `rN` registers, by pre-order statement index.
// ---------------------------------------------------------------------------

const REG_RE = /^r\d+$/;

/** `true` for a Hermes register name (`r0`, `r17`, …) — the only names
 *  `defUse`/`effectSequence` treat as "just a scratch slot" rather than a
 *  visible binding. Exported so `src/passes/index.ts`'s F10 finaliser (which
 *  needs the same test to decide which of a function's leading `decl let
 *  r0…rN` are still live) does not duplicate it. */
export function isRegisterName(name: string): boolean {
  return REG_RE.test(name);
}

export interface DefUse {
  readonly defs: number[];
  readonly reads: number[];
}

/** `rN` defs/reads only (this is expr-rebuild's register-liveness question,
 *  not a general def/use table) — indexed by the statement's own pre-order
 *  position in `stmts` (nested statements get later indices than the
 *  statement containing them, assigned before recursing into it). A nested
 *  `func`'s own registers belong to a different frame and are not counted. */
export function defUse(stmts: readonly Stmt[]): Map<string, DefUse> {
  const out = new Map<string, DefUse>();
  let index = 0;
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

// ---------------------------------------------------------------------------
// Purity.
// ---------------------------------------------------------------------------

/** Literals, idents, `this`, and unary/binary/logical/cond built entirely
 *  from pure operands. Deliberately **not** `member` (getters), `call`,
 *  `new`, or `assign` — those may have side effects a caller must not fold
 *  away or reorder. */
export function isPure(e: Expr): boolean {
  switch (e.k) {
    case "lit":
    case "ident":
    case "this":
      return true;
    case "unary":
      return isPure(e.arg);
    case "bin":
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
  | { readonly k: "call"; readonly callee: string; readonly arity: number }
  | { readonly k: "new"; readonly callee: string; readonly arity: number }
  | { readonly k: "member-write" }
  | { readonly k: "member-read" }
  | { readonly k: "delete" }
  | { readonly k: "throw" }
  | { readonly k: "return" }
  | { readonly k: "assign"; readonly name: string };

/** A callee's shape for effect comparison: the property name for a member
 *  callee (the part that decides *what* gets called), the bare node kind
 *  otherwise — deliberately coarse, since a rewrite may fold `r5` into the
 *  expression that computed it without changing what is actually invoked. */
function calleeShape(e: Expr): string {
  return e.k === "member" ? (e.computed ? "member[computed]" : `member.${(e.prop as { readonly text: string }).text}`) : e.k;
}

/**
 * The ordered, observable effects of `stmts`: every `call`/`new` (by callee
 * shape + arity), every member write and every member **read**, `delete`,
 * `throw`, `return`, and an assignment to a non-`rN` name or to an `rN` a
 * nested closure captures (`identUses(stmts, name).nested > 0` — a plain
 * scratch register's reassignment is not observable outside this list, but
 * one a closure has already captured is). This is the whole guard an
 * expression-only stage-B rewrite gets: reorder or drop nothing here, and it
 * may do anything else it likes to how a value gets computed.
 */
export function effectSequence(stmts: readonly Stmt[]): readonly Effect[] {
  const out: Effect[] = [];
  const isVisible = (name: string): boolean => !isRegisterName(name) || identUses(stmts, name).nested > 0;
  const visitExpr = (e: Expr): void => {
    switch (e.k) {
      case "call":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        out.push({ k: "call", callee: calleeShape(e.callee), arity: e.args.length });
        return;
      case "new":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        out.push({ k: "new", callee: calleeShape(e.callee), arity: e.args.length });
        return;
      case "member":
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        out.push({ k: "member-read" });
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
        e.props.forEach((p) => visitExpr(p.value));
        return;
      case "seq":
        e.exprs.forEach(visitExpr);
        return;
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

/** §4.3's expression-only `check`: the effect sequence is unchanged, and no
 *  `rN` in `after` is read before its own first def in `after` (a rewrite
 *  must not read a register earlier than the point it is actually computed). */
export function expressionOnlyCheck(before: readonly Stmt[], after: readonly Stmt[]): CheckResult {
  const eb = JSON.stringify(effectSequence(before));
  const ea = JSON.stringify(effectSequence(after));
  if (eb !== ea) return { ok: false, reason: "the rewrite changed the observable effect sequence" };
  for (const [name, { defs, reads }] of defUse(after)) {
    if (defs.length === 0) continue; // read-only in this list: defined earlier, outside it
    const firstDef = Math.min(...defs);
    if (reads.some((r) => r < firstDef)) return { ok: false, reason: `${name} is read before its first def in the rewrite` };
  }
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
    let firedHere = false;
    for (let guard = 0; guard < MAX_SITES_PER_PASS; guard++) {
      const ctx: PassContext = { ...base, applied: appliedNames, fnBody: current };
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
