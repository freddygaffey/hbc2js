// jsx-recover matcher — docs/LOWERING-CATALOGUE.md row R6, D20,
// docs/specs/passes/08-jsx-recovery.md §4 (and its "Implementation notes").
//
// Site = one statement list `L`. One match carries **every** element-creation
// call in the list (spec 05 §4's batched convention, as template-literal):
// `deriveSites` folds over the list statement by statement, so an inner
// element already rewritten in an array-slot store is what an outer element
// absorbs as a child. It is total and pure over `(list, fnBody)`; `check.ts`
// calls it again on `before` alone ("recompute, do not trust `match`").
//
// What the rung actually sees (spec §2 is what a source-level reading
// predicts; the bytecode spills every operand — measured on rn-template
// module_422/315 and fixture 59, all five versions):
//
//   rF = X.jsx;            // factory callee spilled to a register (kept)
//   rT = _e0_2;            // type spilled (absorbed: a member/ident read)
//   rP = {};               // config built by stores (absorbed: fresh object)
//   rP.style = r6;
//   rP.children = r1;
//   r8 = rF(rT, rP);       // the call — becomes `r8 = <_e0_2 style={r6}>{r1}</_e0_2>`
//
// Only the *call* node is replaced; the callee register's definition stays
// where it is (the JSX hides `rF`, `factory.callee` records it, and the
// inverse `jsxToCall` reproduces `rF(...)` exactly). The type/config/children
// definitions the element evaluates are absorbed into the node — deleted from
// the list — under guards that make the lowered call evaluate the same
// effects in the same order as the statements it replaces:
//   * every absorbed statement is a plain register definition (`rT = TYPE`,
//     `rP = {…}`, `rA = new Array(n)`) or a store onto that fresh object/array
//     (`rP.k = v`, `rA[i] = v`), with `v` **pure** — except that exactly one
//     moved value (or the type read) may be impure, provided nothing but pure
//     statements and fresh stores sits between it and the call and the
//     lowered evaluation order keeps it in the same place (`moved-impure`);
//   * no in-between statement that is not absorbed is anything but
//     `isPureStmt` (`clobbered-span`), none writes a name a moved value reads
//     (`input-clobbered`), and no moved value reads an absorbed register
//     (`reads-absorbed`);
//   * each absorbed register is dead after the call — redefined by the call's
//     own statement, or by the next plain store to it with only simple
//     statements in between (`not-dead`); a non-register name must have no
//     nested-closure use;
//   * the list is not inside a `try` (a handler could observe the transient
//     register values the absorption removes — `in-try`).
// A site that fails any guard stays a call and is counted in the refusal
// histogram; `collectCalls` never enters a `jsx` node or a nested `func`, so
// the rung is a structural fixed point (PL-08).
import type { Expr, JsxAttr, JsxChild, JsxFactory, Stmt } from "../ast.ts";
import { identUses, isPure, isPureStmt, isRegisterName, stmtLists } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason =
  | "bad-type"
  | "dynamic-config"
  | "null-config"
  | "jsxs-nonarray"
  | "ambiguous-createElement"
  | "reflect-apply-callee"
  | "arity"
  | "moved-impure"
  | "clobbered-span"
  | "input-clobbered"
  | "reads-absorbed"
  | "not-dead"
  | "in-try";

export interface JsxSite {
  /** Index in the (input) list of the statement holding the call. */
  readonly stmtIndex: number;
  /** The call node replaced, as it stood in the folded list (identity). */
  readonly call: Expr;
  /** `call` with every absorbed register operand replaced by the value its
   *  deleted definition held — the call the guards prove equivalent, and the
   *  one `jsxToCall(node)` must reproduce exactly (`check.ts`). Built from
   *  the raw collected props, not from `node`. */
  readonly resolved: Expr;
  /** Its replacement. `jsxToCall(node)` is structurally `call`. */
  readonly node: Extract<Expr, { k: "jsx" }>;
  /** Input-list indices of the statements the node absorbed (deleted). */
  readonly absorbed: readonly number[];
  readonly runtime: "automatic" | "classic";
}

export interface JsxSites {
  readonly sites: readonly JsxSite[];
  /** The rewritten list — `rewrite` returns exactly this. */
  readonly after: readonly Stmt[];
  readonly refusals: Readonly<Record<string, number>>;
}

export type JsxMatch = Match<readonly Stmt[], JsxSites>;

const AUTOMATIC = new Set(["jsx", "jsxs", "jsxDEV"]);
const FACTORY_IDENTS: Readonly<Record<string, string>> = { jsx: "jsx", jsxs: "jsxs", jsxDEV: "jsxDEV", _jsx: "jsx", _jsxs: "jsxs", _jsxDEV: "jsxDEV", createElement: "createElement" };
const REACT_SIBLINGS = new Set(["jsx", "jsxs", "jsxDEV", "Fragment", "Component", "createContext", "useState", "useEffect"]);

// ---------------------------------------------------------------------------
// Small structural helpers.
// ---------------------------------------------------------------------------

/** Non-computed `obj.name`, or computed `obj["name"]`. */
function memberName(e: Expr): string | null {
  if (e.k !== "member" || e.prop.k !== "lit") return null;
  if (!e.computed) return e.prop.text;
  try {
    const v: unknown = JSON.parse(e.prop.text);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function isFactoryName(name: string | null): name is string {
  return name !== null && (AUTOMATIC.has(name) || name === "createElement");
}

/** The expression fields of one statement that belong to *this* list (never
 *  a nested block's statements — those are their own site). */
function exprFieldsOf(s: Stmt): readonly Expr[] {
  switch (s.k) {
    case "expr":
      return [s.expr];
    case "init":
      return [s.value];
    case "if":
    case "do-while":
      return [s.test];
    case "while":
      return s.test === undefined ? [] : [s.test];
    case "for":
      return [...(s.init === null ? [] : [s.init]), s.test, ...(s.update === null ? [] : [s.update])];
    case "return":
      return s.arg === null ? [] : [s.arg];
    case "throw":
      return [s.arg];
    case "switch":
      return [s.disc];
    default:
      return [];
  }
}

/** Every `call` under `e`, innermost first; never inside a nested `func`
 *  (a separate frame/site) or a `jsx` node (already recovered). */
function collectCalls(e: Expr, out: Expr[]): void {
  switch (e.k) {
    case "member":
      collectCalls(e.obj, out);
      if (e.computed) collectCalls(e.prop, out);
      return;
    case "call":
    case "new":
      collectCalls(e.callee, out);
      e.args.forEach((a) => collectCalls(a, out));
      if (e.k === "call") out.push(e);
      return;
    case "bin":
    case "logical":
      collectCalls(e.left, out);
      collectCalls(e.right, out);
      return;
    case "unary":
      collectCalls(e.arg, out);
      return;
    case "assign":
      collectCalls(e.target, out);
      collectCalls(e.value, out);
      return;
    case "cond":
      collectCalls(e.test, out);
      collectCalls(e.then, out);
      collectCalls(e.else, out);
      return;
    case "array":
      e.elements.forEach((x) => collectCalls(x, out));
      return;
    case "object":
      e.props.forEach((p) => collectCalls(p.value, out));
      return;
    case "seq":
    case "template":
      e.exprs.forEach((x) => collectCalls(x, out));
      return;
    case "tagged":
      collectCalls(e.tag, out);
      collectCalls(e.quasi, out);
      return;
    default:
      return; // ident, lit, this, argumentsObject, func, jsx
  }
}

/** Rebuild `e`, replacing the node identical to `target` with `repl`. Never
 *  descends into a nested `func` or a `jsx` node. */
function replaceNode(e: Expr, target: Expr, repl: Expr): Expr {
  if (e === target) return repl;
  switch (e.k) {
    case "member": {
      const obj = replaceNode(e.obj, target, repl);
      const prop = e.computed ? replaceNode(e.prop, target, repl) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "new": {
      const callee = replaceNode(e.callee, target, repl);
      const args = e.args.map((a) => replaceNode(a, target, repl));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = replaceNode(e.left, target, repl);
      const right = replaceNode(e.right, target, repl);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = replaceNode(e.arg, target, repl);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const t = replaceNode(e.target, target, repl);
      const v = replaceNode(e.value, target, repl);
      return t === e.target && v === e.value ? e : { ...e, target: t, value: v };
    }
    case "cond": {
      const test = replaceNode(e.test, target, repl);
      const then = replaceNode(e.then, target, repl);
      const els = replaceNode(e.else, target, repl);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => replaceNode(x, target, repl));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        const v = replaceNode(p.value, target, repl);
        if (v !== p.value) changed = true;
        return v === p.value ? p : { ...p, value: v };
      });
      return changed ? { ...e, props } : e;
    }
    case "seq":
    case "template": {
      const exprs = e.exprs.map((x) => replaceNode(x, target, repl));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : ({ ...e, exprs } as Expr);
    }
    case "tagged": {
      const tag = replaceNode(e.tag, target, repl);
      const quasi = replaceNode(e.quasi, target, repl);
      return tag === e.tag && quasi === e.quasi ? e : { ...e, tag, quasi };
    }
    default:
      return e;
  }
}

function replaceInStmt(s: Stmt, target: Expr, repl: Expr): Stmt {
  switch (s.k) {
    case "expr":
      return { ...s, expr: replaceNode(s.expr, target, repl) };
    case "init":
      return { ...s, value: replaceNode(s.value, target, repl) };
    case "if":
      return { ...s, test: replaceNode(s.test, target, repl) };
    case "while":
      return s.test === undefined ? s : { ...s, test: replaceNode(s.test, target, repl) };
    case "do-while":
      return { ...s, test: replaceNode(s.test, target, repl) };
    case "for":
      return { ...s, init: s.init === null ? null : replaceNode(s.init, target, repl), test: replaceNode(s.test, target, repl), update: s.update === null ? null : replaceNode(s.update, target, repl) };
    case "return":
      return s.arg === null ? s : { ...s, arg: replaceNode(s.arg, target, repl) };
    case "throw":
      return { ...s, arg: replaceNode(s.arg, target, repl) };
    case "switch":
      return { ...s, disc: replaceNode(s.disc, target, repl) };
    default:
      return s;
  }
}

/** `name = value` as a top-level statement (assign-expr or `init`). */
function plainDef(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

/** `obj.key = value` (non-computed) or `obj[i] = value` (numeric literal). */
function store(s: Stmt): { readonly obj: string; readonly key: string; readonly computed: boolean; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "member" || s.expr.target.obj.k !== "ident" || s.expr.target.prop.k !== "lit") return null;
  return { obj: s.expr.target.obj.name, key: s.expr.target.prop.text, computed: s.expr.target.computed, value: s.expr.value };
}

function mentions(s: Stmt, name: string): boolean {
  const u = identUses([s], name);
  return u.reads + u.writes + u.nested > 0;
}

/** Names `e` reads (identifiers at any depth, not entering a nested `func`). */
function namesRead(e: Expr, out: Set<string>): void {
  switch (e.k) {
    case "ident":
      out.add(e.name);
      return;
    case "member":
      namesRead(e.obj, out);
      if (e.computed) namesRead(e.prop, out);
      return;
    case "call":
    case "new":
      namesRead(e.callee, out);
      e.args.forEach((a) => namesRead(a, out));
      return;
    case "bin":
    case "logical":
      namesRead(e.left, out);
      namesRead(e.right, out);
      return;
    case "unary":
      namesRead(e.arg, out);
      return;
    case "assign":
      namesRead(e.target, out);
      namesRead(e.value, out);
      return;
    case "cond":
      namesRead(e.test, out);
      namesRead(e.then, out);
      namesRead(e.else, out);
      return;
    case "array":
      e.elements.forEach((x) => namesRead(x, out));
      return;
    case "object":
      e.props.forEach((p) => namesRead(p.value, out));
      return;
    case "seq":
    case "template":
      e.exprs.forEach((x) => namesRead(x, out));
      return;
    case "tagged":
      namesRead(e.tag, out);
      namesRead(e.quasi, out);
      return;
    case "jsx": {
      // The node is its call: every part is read.
      const f = e.factory;
      namesRead(f.callee, out);
      namesRead(e.tag, out);
      for (const a of e.attrs) namesRead("spread" in a ? a.spread : (a.value ?? { k: "lit", text: "true" }), out);
      for (const c of e.children) namesRead(c.k === "expr" ? c.expr : c.lit, out);
      if (f.runtime === "automatic") {
        if (f.key !== null) namesRead(f.key, out);
        f.rest.forEach((x) => namesRead(x, out));
      } else if (f.nullProps !== null) namesRead(f.nullProps, out);
      return;
    }
    default:
      return; // lit, this, argumentsObject, func
  }
}

/** A JSX tag: a string literal naming an intrinsic element, a bare identifier
 *  that JSX reads as a component reference (anything **not** starting with a
 *  lowercase letter — Babel's `isCompatTag` is `/^[a-z]/`; an env slot
 *  `_e0_2` therefore qualifies, a register `r4` never does), or a member
 *  chain over identifiers (`Ns.Comp`, `_e0_5.Comp`, `React.Fragment`). */
function isTagExpr(e: Expr): boolean {
  if (e.k === "lit") {
    if (!e.text.startsWith('"')) return false;
    try {
      const v: unknown = JSON.parse(e.text);
      return typeof v === "string" && /^[a-zA-Z_][\w-]*$/.test(v);
    } catch {
      return false;
    }
  }
  if (e.k === "ident") return !/^[a-z]/.test(e.name) && /^[A-Za-z_$][\w$]*$/.test(e.name);
  if (e.k === "member") {
    if (e.computed || e.prop.k !== "lit" || !/^[A-Za-z_$][\w$]*$/.test(e.prop.text)) return false;
    return isMemberChainBase(e.obj);
  }
  return false;
}

function isMemberChainBase(e: Expr): boolean {
  if (e.k === "ident") return /^[A-Za-z_$][\w$]*$/.test(e.name);
  if (e.k === "this") return true;
  if (e.k === "member") return !e.computed && e.prop.k === "lit" && /^[A-Za-z_$][\w$]*$/.test(e.prop.text) && isMemberChainBase(e.obj);
  return false;
}

/** A tag whose bare identifier would be read as an intrinsic (a register). */
function isComponentTag(e: Expr): boolean {
  return e.k !== "lit" && isTagExpr(e);
}

const JSX_ATTR_NAME = /^[A-Za-z_$][\w$]*(?:-[\w$]+)*$/;

// ---------------------------------------------------------------------------
// Whole-function facts, memoised per `fnBody` identity.
// ---------------------------------------------------------------------------

interface FnFacts {
  /** Lists nested (at any depth) inside a `try` block or handler. */
  readonly inTry: ReadonlySet<readonly Stmt[]>;
  /** Each nested list's enclosing list, the index of the statement holding
   *  it there, and whether that statement re-executes its body (a loop). */
  readonly parents: ReadonlyMap<readonly Stmt[], { readonly list: readonly Stmt[]; readonly index: number; readonly loop: boolean; readonly switchCase: boolean }>;
  /** JSON keys of receivers `obj` seen as `obj.<react sibling>` anywhere. */
  readonly reactReceivers: ReadonlySet<string>;
}

const factsMemo = new WeakMap<readonly Stmt[], FnFacts>();

function fnFacts(fnBody: readonly Stmt[]): FnFacts {
  let f = factsMemo.get(fnBody);
  if (f !== undefined) return f;
  const inTry = new Set<readonly Stmt[]>();
  const reactReceivers = new Set<string>();
  const parents = new Map<readonly Stmt[], { list: readonly Stmt[]; index: number; loop: boolean; switchCase: boolean }>();
  const visitExpr = (e: Expr): void => {
    if (e.k === "member") {
      const name = memberName(e);
      if (name !== null && REACT_SIBLINGS.has(name)) reactReceivers.add(JSON.stringify(e.obj));
    }
    // A shallow structural descent is enough for receiver evidence.
    switch (e.k) {
      case "member":
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        return;
      case "call":
      case "new":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        return;
      case "assign":
        visitExpr(e.target);
        visitExpr(e.value);
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
      case "unary":
        visitExpr(e.arg);
        return;
      default:
        return;
    }
  };
  const visit = (list: readonly Stmt[], inside: boolean): void => {
    if (inside) inTry.add(list);
    list.forEach((s, index) => {
      for (const e of exprFieldsOf(s)) visitExpr(e);
      const child = (sub: readonly Stmt[], loop: boolean, switchCase: boolean, tryInside: boolean): void => {
        parents.set(sub, { list, index, loop, switchCase });
        visit(sub, tryInside);
      };
      switch (s.k) {
        case "if":
          child(s.then, false, false, inside);
          child(s.else, false, false, inside);
          break;
        case "while":
        case "do-while":
        case "for":
          child(s.body, true, false, inside);
          break;
        case "labeled":
        case "iife":
          child(s.body, false, false, inside);
          break;
        case "try":
          child(s.block, false, false, true);
          child(s.handler, false, false, true);
          break;
        case "switch":
          for (const c of s.cases) child(c.body, false, true, inside);
          break;
        default:
          break;
      }
    });
  };
  visit(fnBody, false);
  f = { inTry, reactReceivers, parents };
  factsMemo.set(fnBody, f);
  return f;
}

// ---------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------

interface Moved {
  /** Input-list index of the statement the value came from. */
  readonly at: number;
  readonly value: Expr;
}

interface Absorption {
  readonly tag: Expr;
  readonly attrs: JsxAttr[];
  readonly children: JsxChild[];
  readonly childrenAt: number | null;
  readonly childrenShape: "single" | "array";
  readonly nullProps: Expr | null;
  /** The config/props argument with absorbed registers substituted. */
  resolvedConfig: Expr | null;
  /** A parent-list tag definition, shown instead of the register. */
  tagDisplay: Expr | null;
  /** Input-list indices deleted. */
  readonly absorbed: Set<number>;
  /** Registers whose definitions are deleted → the definition's index. */
  readonly regs: Map<string, number>;
  /** Every value that moves to the call, in lowered evaluation order. */
  readonly moved: Moved[];
}

class Refuse extends Error {
  readonly reason: RefuseReason;
  constructor(reason: RefuseReason) {
    super(reason);
    this.reason = reason;
  }
}

interface Fold {
  readonly cur: Stmt[];
  readonly deleted: Set<number>;
  readonly fnBody: readonly Stmt[];
  readonly facts: FnFacts;
  /** The list *is* the function body: past its end the frame is gone. */
  readonly isBody: boolean;
}

/** A definition of `name` inside a sibling labeled block that dominates the
 *  statement after the block: a top-level `name = value` in its body with
 *  only simple statements (nothing that could `break` out early) before it
 *  and no write to `name` at any depth after it. Identification only. */
function defInLabeled(s: Stmt, name: string): Expr | null {
  if (s.k !== "labeled") return null;
  const body = s.body;
  for (let j = body.length - 1; j >= 0; j--) {
    const st = body[j]!;
    const d = plainDef(st);
    if (d !== null && d.name === name) {
      for (let k = 0; k < j; k++) {
        const b = body[k]!.k;
        if (b !== "expr" && b !== "init" && b !== "decl" && b !== "comment") return null;
      }
      return d.value;
    }
    if (identUses([st], name).writes > 0) return null;
  }
  return null;
}

/** Nearest preceding live top-level `name = value` before `i`, with no other
 *  write to `name` (at any depth) in between. `absorbable` is false when the
 *  definition sits inside a sibling labeled block (`defInLabeled`): it
 *  identifies the value but can never be deleted from this list. */
function nearestDef(f: Fold, i: number, name: string): { readonly index: number; readonly value: Expr; readonly absorbable: boolean } | null {
  for (let j = i - 1; j >= 0; j--) {
    if (f.deleted.has(j)) continue;
    const s = f.cur[j]!;
    const d = plainDef(s);
    if (d !== null && d.name === name) return { index: j, value: d.value, absorbable: true };
    const inLabeled = defInLabeled(s, name);
    if (inLabeled !== null) return { index: j, value: inLabeled, absorbable: false };
    if (identUses([s], name).writes > 0) return null;
  }
  return null;
}

/** Like `nearestDef`, but when the list runs out without a write, climbs to
 *  the enclosing list and keeps scanning before the statement that holds this
 *  one — for *identification only* (the definition found is never absorbed):
 *  sound because no statement between it and the use writes `name` on any
 *  path that reaches the use, which needs (a) no write in this list before
 *  `i` at any depth (the in-list scan), (b) no write in an enclosing loop
 *  body at all (the next iteration would see it), (c) no write in a sibling
 *  `switch` case (fall-through), and (d) no write between the definition and
 *  the enclosing statement, at any depth. */
function nearestDefUp(f: Fold, list: readonly Stmt[], i: number, name: string): Expr | null {
  const inList = nearestDef(f, i, name);
  if (inList !== null) return inList.value;
  for (let j = i - 1; j >= 0; j--) if (!f.deleted.has(j) && identUses([f.cur[j]!], name).writes > 0) return null;
  let cur = list;
  for (;;) {
    const p = f.facts.parents.get(cur);
    if (p === undefined) return null;
    const holder = p.list[p.index]!;
    if (p.loop && identUses([holder], name).writes > 0) return null;
    if (p.switchCase && holder.k === "switch" && holder.cases.some((c) => c.body !== cur && identUses(c.body, name).writes > 0)) return null;
    for (let j = p.index - 1; j >= 0; j--) {
      const d = plainDef(p.list[j]!);
      if (d !== null && d.name === name) return d.value;
      const inLabeled = defInLabeled(p.list[j]!, name);
      if (inLabeled !== null) return inLabeled;
      if (identUses([p.list[j]!], name).writes > 0) return null;
    }
    cur = p.list;
  }
}

/** Resolve the callee to a factory: `{ callee, name }` or a refusal. */
function resolveFactory(f: Fold, list: readonly Stmt[], i: number, callee: Expr): { readonly callee: Expr; readonly name: string } | null {
  const mn = memberName(callee);
  if (isFactoryName(mn)) return { callee, name: mn };
  if (callee.k !== "ident") return null;
  const byName = FACTORY_IDENTS[callee.name];
  if (byName !== undefined) return { callee, name: byName };
  const d = nearestDefUp(f, list, i, callee.name);
  if (d === null) return null;
  const dn = memberName(d);
  return isFactoryName(dn) ? { callee, name: dn } : null;
}

/** Statements strictly between `from` and `to` that are live and not the
 *  site's own; every one must be `isPureStmt`. */
function assertCleanSpan(f: Fold, from: number, to: number, own: ReadonlySet<number>): void {
  for (let j = from + 1; j < to; j++) {
    if (f.deleted.has(j) || own.has(j)) continue;
    if (!isPureStmt(f.cur[j]!)) throw new Refuse("clobbered-span");
  }
}

/** `reg` is dead after statement `i`: redefined there, or by the next plain
 *  store with only simple statements (no control transfer) in between. */
function deadAfter(f: Fold, i: number, reg: string): boolean {
  const at = plainDef(f.cur[i]!);
  if (at !== null && at.name === reg) return true;
  for (let j = i + 1; j < f.cur.length; j++) {
    if (f.deleted.has(j)) continue;
    const s = f.cur[j]!;
    const d = plainDef(s);
    if (d !== null && d.name === reg) {
      const reads = new Set<string>();
      namesRead(d.value, reads);
      return !reads.has(reg);
    }
    if (mentions(s, reg)) return false;
    if (s.k !== "expr" && s.k !== "init" && s.k !== "decl" && s.k !== "comment") return false;
  }
  return f.isBody;
}

/** Resolve the type argument: in place, or a register whose nearest
 *  definition is a tag expression (absorbed). */
function resolveType(f: Fold, list: readonly Stmt[], i: number, arg: Expr, a: Absorption): Expr {
  if (isTagExpr(arg)) return arg;
  if (arg.k !== "ident") throw new Refuse("bad-type");
  const d = nearestDef(f, i, arg.name);
  if (d !== null && d.absorbable) {
    if (!isTagExpr(d.value)) throw new Refuse("bad-type");
    // Absorb only a private copy (v94 spills one per call); a definition
    // shared by later calls (v99 hoists it) or read in between is kept and
    // shown through `tagDisplay` instead.
    let mentionedBetween = false;
    for (let j = d.index + 1; j < i && !mentionedBetween; j++) if (!f.deleted.has(j) && mentions(f.cur[j]!, arg.name)) mentionedBetween = true;
    if (!mentionedBetween && deadAfter(f, i, arg.name)) {
      a.absorbed.add(d.index);
      a.regs.set(arg.name, d.index);
      a.moved.push({ at: d.index, value: d.value });
      return d.value;
    }
    a.tagDisplay = d.value;
    return arg;
  }
  // Defined in an enclosing list: keep that definition, print what the
  // register provably holds (`tagDisplay`), and keep the register as the
  // exact tag operand for the inverse.
  const up = nearestDefUp(f, list, i, arg.name);
  if (up === null || !isTagExpr(up)) throw new Refuse("bad-type");
  a.tagDisplay = up;
  return arg;
}

/** A register defined as `new Array(n)` and filled by `r[k] = v` stores for
 *  every `k < n` in order → the elements (absorbed), else `null`. */
function resolveArray(f: Fold, i: number, arg: Expr, a: Absorption): readonly Moved[] | null {
  if (arg.k === "array") return arg.elements.map((value) => ({ at: i, value }));
  if (arg.k !== "ident") return null;
  const d = nearestDef(f, i, arg.name);
  if (d === null || !d.absorbable) return null;
  const v = d.value;
  if (v.k !== "new" || v.callee.k !== "ident" || v.callee.name !== "Array" || v.args.length !== 1 || v.args[0]!.k !== "lit" || !/^\d+$/.test((v.args[0] as { text: string }).text)) return null;
  const n = Number((v.args[0] as { text: string }).text);
  const elements: Moved[] = [];
  const own = new Set<number>([d.index]);
  for (let j = d.index + 1; j < i && elements.length < n; j++) {
    if (f.deleted.has(j)) continue;
    const st = store(f.cur[j]!);
    if (st !== null && st.obj === arg.name) {
      if (!st.computed || st.key !== String(elements.length)) return null;
      elements.push({ at: j, value: st.value });
      own.add(j);
      continue;
    }
    if (!a.absorbed.has(j) && mentions(f.cur[j]!, arg.name)) return null;
  }
  if (elements.length !== n) return null;
  for (let j = d.index + 1; j < i; j++) {
    if (!f.deleted.has(j) && !own.has(j) && !a.absorbed.has(j) && mentions(f.cur[j]!, arg.name)) return null;
  }
  for (const k of own) a.absorbed.add(k);
  a.regs.set(arg.name, d.index);
  return elements;
}

/** Resolve the config/props argument into attrs + children. */
function resolveConfig(f: Fold, i: number, arg: Expr, a: Absorption, runtime: "automatic" | "classic", name: string): void {
  let props: readonly { readonly key: string; readonly computed: boolean; readonly value: Expr; readonly at: number }[];
  if (arg.k === "object") {
    props = arg.props.map((p) => ({ ...p, at: i }));
  } else if (arg.k === "lit" && (arg.text === "null" || arg.text === "undefined")) {
    if (runtime === "automatic") throw new Refuse("null-config");
    (a as { nullProps: Expr | null }).nullProps = arg;
    a.resolvedConfig = arg;
    props = [];
  } else if (arg.k === "ident") {
    const d = nearestDef(f, i, arg.name);
    if (d !== null && d.absorbable && d.value.k === "object") {
      const own = new Set<number>([d.index]);
      const collected: { key: string; computed: boolean; value: Expr; at: number }[] = d.value.props.map((p) => ({ ...p, at: d.index }));
      for (let j = d.index + 1; j < i; j++) {
        if (f.deleted.has(j)) continue;
        const st = store(f.cur[j]!);
        if (st !== null && st.obj === arg.name) {
          collected.push({ key: st.key, computed: st.computed, value: st.value, at: j });
          own.add(j);
          continue;
        }
        if (mentions(f.cur[j]!, arg.name)) throw new Refuse("dynamic-config");
      }
      for (const k of own) a.absorbed.add(k);
      a.regs.set(arg.name, d.index);
      props = collected;
    } else {
      // A lone spread source (spec §4): `{...x}`.
      if (isRegisterName(arg.name) && (d === null || !d.absorbable)) throw new Refuse("dynamic-config");
      a.attrs.push({ spread: arg });
      a.moved.push({ at: i, value: arg });
      a.resolvedConfig = arg;
      return;
    }
  } else {
    throw new Refuse("dynamic-config");
  }

  // v99's `NewObjectWithBuffer` seeds the literal with placeholders
  // (`{style: null, children: null}`) the following stores overwrite; on a
  // fresh object a later store of the same key wins, and dropping a *pure*
  // placeholder's evaluation is unobservable — so keep the last entry per
  // key. An impure earlier value would be an effect lost: refuse.
  const lastByKey = new Map<string, number>();
  props.forEach((p, k) => lastByKey.set(p.key, k));
  const deduped = props.filter((p, k) => {
    if (lastByKey.get(p.key) === k) return true;
    if (!isPure(p.value)) throw new Refuse("dynamic-config");
    return false;
  });
  const resolvedProps: { key: string; computed: boolean; value: Expr }[] = [];
  for (const p of deduped) {
    if (p.computed || !JSX_ATTR_NAME.test(p.key)) throw new Refuse("dynamic-config");
    if (runtime === "automatic" && p.key === "children") {
      if (a.childrenAt !== null) throw new Refuse("dynamic-config");
      (a as { childrenAt: number | null }).childrenAt = a.attrs.length;
      if (name === "jsxs") {
        const elements = resolveArray(f, i, p.value, a);
        if (elements === null) throw new Refuse("jsxs-nonarray");
        (a as { childrenShape: "single" | "array" }).childrenShape = "array";
        for (const el of elements) {
          a.children.push(childOf(el.value));
          a.moved.push(el);
        }
        resolvedProps.push({ key: p.key, computed: false, value: p.value.k === "array" ? p.value : { k: "array", elements: elements.map((el) => el.value) } });
      } else {
        (a as { childrenShape: "single" | "array" }).childrenShape = "single";
        a.children.push(childOf(p.value));
        a.moved.push({ at: p.at, value: p.value });
        resolvedProps.push({ key: p.key, computed: false, value: p.value });
      }
      continue;
    }
    a.attrs.push({ name: p.key, value: p.value });
    a.moved.push({ at: p.at, value: p.value });
    resolvedProps.push({ key: p.key, computed: false, value: p.value });
  }
  if (a.resolvedConfig === null) a.resolvedConfig = arg.k === "object" ? arg : { k: "object", props: resolvedProps };
}

function childOf(value: Expr): JsxChild {
  return value.k === "lit" && value.text.startsWith('"') ? { k: "text", lit: value } : { k: "expr", expr: value };
}

/** Try to make a site out of `call` at statement `i` of the fold. */
function trySite(f: Fold, i: number, call: Extract<Expr, { k: "call" }>, list: readonly Stmt[]): JsxSite | RefuseReason | null {
  // `Reflect.apply(F, T, [args])` with a factory `F`: call-shape's residue.
  if (memberName(call.callee) === "apply" && call.callee.k === "member" && call.callee.obj.k === "ident" && call.callee.obj.name === "Reflect" && call.args.length === 3) {
    const fac = resolveFactory(f, list, i, call.args[0]!);
    return fac === null ? null : "reflect-apply-callee";
  }
  const fac = resolveFactory(f, list, i, call.callee);
  if (fac === null) return null;
  const runtime: "automatic" | "classic" = fac.name === "createElement" ? "classic" : "automatic";
  try {
    if (f.facts.inTry.has(list)) throw new Refuse("in-try");
    const args = call.args;
    if (runtime === "automatic") {
      const max = fac.name === "jsxDEV" ? 6 : 3;
      if (args.length < 2 || args.length > max) throw new Refuse("arity");
    } else if (args.length < 2) throw new Refuse("arity");

    const a: Absorption = { tag: args[0]!, attrs: [], children: [], childrenAt: null, childrenShape: "single", nullProps: null, resolvedConfig: null, tagDisplay: null, absorbed: new Set(), regs: new Map(), moved: [] };
    const tag = resolveType(f, list, i, args[0]!, a);
    if (runtime === "classic") {
      // Spec §4 B: DOM's `document.createElement` never takes a props object;
      // still require a component tag or React evidence on the receiver.
      const receiverIsReact = fac.callee.k === "member" && f.facts.reactReceivers.has(JSON.stringify(fac.callee.obj));
      if (!isComponentTag(a.tagDisplay ?? tag) && !receiverIsReact) throw new Refuse("ambiguous-createElement");
    }
    resolveConfig(f, i, args[1]!, a, runtime, fac.name);
    let factory: JsxFactory;
    if (runtime === "automatic") {
      const key = args[2] ?? null;
      const rest = args.slice(3);
      if (key !== null) a.moved.push({ at: i, value: key });
      for (const r of rest) a.moved.push({ at: i, value: r });
      factory = { runtime, callee: fac.callee, key, childrenAt: a.childrenAt, childrenShape: a.childrenShape, rest };
    } else {
      for (const c of args.slice(2)) {
        a.children.push(childOf(c));
        a.moved.push({ at: i, value: c });
      }
      factory = { runtime, callee: fac.callee, nullProps: a.nullProps };
    }

    // --- guards on what moved ------------------------------------------------
    if (a.absorbed.size > 0) {
      // A deleted register definition must be invisible to everything that
      // survives between it and the call.
      for (const [r, d] of a.regs) {
        for (let j = d + 1; j < i; j++) {
          if (f.deleted.has(j) || a.absorbed.has(j)) continue;
          if (mentions(f.cur[j]!, r)) throw new Refuse("clobbered-span");
        }
      }
      // A pure moved value may pass any statement that does not clobber its
      // inputs (checked below); an impure one may pass only pure statements,
      // so the span after the first impure moved value must be clean.
      const firstImpureAt = Math.min(i, ...a.moved.filter((m) => m.at < i && !isPure(m.value)).map((m) => m.at));
      assertCleanSpan(f, firstImpureAt, i, a.absorbed);
      for (const r of a.regs.keys()) {
        if (!isRegisterName(r) && identUses(f.fnBody, r).nested > 0) throw new Refuse("not-dead");
        if (!deadAfter(f, i, r)) throw new Refuse("not-dead");
      }
      // Impure moved values: at most one, last among effects, and every
      // statement between it and the call is the site's own or pure.
      const impure = a.moved.filter((m) => m.at < i && !isPure(m.value));
      if (impure.length > 1) throw new Refuse("moved-impure");
      if (impure.length === 1) {
        const m = impure[0]!;
        const loweredIdx = a.moved.indexOf(m);
        // Everything evaluated before it in the lowered form must be pure or
        // originally positioned before it too.
        for (let k = 0; k < loweredIdx; k++) {
          const o = a.moved[k]!;
          if (!isPure(o.value) || o.at > m.at) throw new Refuse("moved-impure");
        }
        for (let k = loweredIdx + 1; k < a.moved.length; k++) {
          const o = a.moved[k]!;
          if (!isPure(o.value)) throw new Refuse("moved-impure");
        }
      }
      for (const m of a.moved) {
        if (m.at >= i) continue;
        const reads = new Set<string>();
        namesRead(m.value, reads);
        for (const r of reads) {
          const d = a.regs.get(r);
          if (d !== undefined && m.at > d) throw new Refuse("reads-absorbed");
        }
        for (let j = m.at + 1; j < i; j++) {
          if (f.deleted.has(j) || a.absorbed.has(j)) continue;
          const s = f.cur[j]!;
          for (const r of reads) if (identUses([s], r).writes > 0) throw new Refuse("input-clobbered");
        }
      }
    }

    const node: Extract<Expr, { k: "jsx" }> = { k: "jsx", tag, ...(a.tagDisplay === null ? {} : { tagDisplay: a.tagDisplay }), attrs: a.attrs, children: a.children, selfClosing: a.children.length === 0, factory };
    const resolved: Expr = { k: "call", callee: call.callee, args: [tag, a.resolvedConfig ?? args[1]!, ...args.slice(2)] };
    return { stmtIndex: i, call, resolved, node, absorbed: [...a.absorbed].sort((x, y) => x - y), runtime };
  } catch (e) {
    if (e instanceof Refuse) return e.reason;
    throw e;
  }
}

/**
 * Every recoverable element-creation call in `list`, folded in statement
 * order (an inner element rewritten earlier is what an outer one absorbs),
 * with the rewritten list and the refusal histogram. Pure over its inputs.
 */
export function deriveSites(list: readonly Stmt[], fnBody: readonly Stmt[]): JsxSites {
  const f: Fold = { cur: [...list], deleted: new Set(), fnBody, facts: fnFacts(fnBody), isBody: list === fnBody };
  const sites: JsxSite[] = [];
  const refusals: Record<string, number> = {};
  for (let i = 0; i < f.cur.length; i++) {
    for (;;) {
      const calls: Expr[] = [];
      for (const e of exprFieldsOf(f.cur[i]!)) collectCalls(e, calls);
      let fired = false;
      for (const c of calls) {
        const r = trySite(f, i, c as Extract<Expr, { k: "call" }>, list);
        if (r === null) continue;
        if (typeof r === "string") {
          refusals[r] = (refusals[r] ?? 0) + 1;
          continue;
        }
        f.cur[i] = replaceInStmt(f.cur[i]!, r.call, r.node);
        for (const k of r.absorbed) f.deleted.add(k);
        sites.push(r);
        fired = true;
        break; // the statement changed: re-collect (an outer call may now qualify)
      }
      if (!fired) break;
    }
  }
  const after = f.cur.filter((_, k) => !f.deleted.has(k));
  return { sites, after: sites.length === 0 ? list : after, refusals };
}

export function match(list: readonly Stmt[], ctx: PassContext): JsxMatch | null {
  const data = deriveSites(list, ctx.fnBody ?? list);
  if (data.sites.length === 0) return null;
  return { root: list, nodes: [list], data, at: { functionIndex: ctx.functionIndex, offset: data.sites[0]!.stmtIndex } };
}

/** For the metric: count the `jsx` nodes and the factory call sites still
 *  left (an ident/member callee resolvable to a factory) in `fnBody`. */
export function countElementSites(fnBody: readonly Stmt[]): { readonly recovered: number; readonly residual: number; readonly refusals: Readonly<Record<string, number>> } {
  let recovered = 0;
  let residual = 0;
  const refusals: Record<string, number> = {};
  for (const list of stmtLists(fnBody)) {
    const f: Fold = { cur: [...list], deleted: new Set(), fnBody, facts: fnFacts(fnBody), isBody: list === fnBody };
    for (let i = 0; i < list.length; i++) {
      const calls: Expr[] = [];
      for (const e of exprFieldsOf(list[i]!)) collectCalls(e, calls);
      for (const c of calls) {
        const call = c as Extract<Expr, { k: "call" }>;
        const isReflect = memberName(call.callee) === "apply" && call.callee.k === "member" && call.callee.obj.k === "ident" && call.callee.obj.name === "Reflect" && call.args.length === 3;
        const fac = resolveFactory(f, list, i, isReflect ? call.args[0]! : call.callee);
        if (fac === null) continue;
        residual++;
        const r = trySite(f, i, call, list);
        if (typeof r === "string") refusals[r] = (refusals[r] ?? 0) + 1;
      }
    }
    const countJsx = (e: Expr): void => {
      if (e.k === "jsx") recovered++;
      switch (e.k) {
        case "member":
          countJsx(e.obj);
          countJsx(e.prop);
          return;
        case "call":
        case "new":
          countJsx(e.callee);
          e.args.forEach(countJsx);
          return;
        case "assign":
          countJsx(e.target);
          countJsx(e.value);
          return;
        case "array":
          e.elements.forEach(countJsx);
          return;
        case "object":
          e.props.forEach((p) => countJsx(p.value));
          return;
        case "cond":
          countJsx(e.test);
          countJsx(e.then);
          countJsx(e.else);
          return;
        case "bin":
        case "logical":
          countJsx(e.left);
          countJsx(e.right);
          return;
        case "unary":
          countJsx(e.arg);
          return;
        case "seq":
        case "template":
          e.exprs.forEach(countJsx);
          return;
        case "jsx":
          for (const c of e.children) if (c.k === "expr") countJsx(c.expr);
          for (const a of e.attrs) countJsx("spread" in a ? a.spread : (a.value ?? { k: "lit", text: "true" }));
          return;
        default:
          return;
      }
    };
    for (const s of list) for (const e of exprFieldsOf(s)) countJsx(e);
  }
  return { recovered, residual, refusals };
}
