// call-shape matcher — docs/LOWERING-CATALOGUE.md row R3,
// docs/specs/passes/04-call-shape.md §4.
//
// Site = one statement list `L` (`ctx.fnBody` reachable, innermost first).
// Unlike expr-rebuild/global-access (whose idiom lives at one fixed field of
// one statement), a `Reflect.apply`/`Reflect.construct`/helper call can sit
// anywhere in an expression tree, so `collectCandidates` walks every
// statement's own expression fields in pre-order (never descending into a
// nested `func` body or a nested `Stmt[]` — both are separate `stmtLists`
// sites) and `classifyNode` is total over any `call` node reachable that
// way: for a node whose callee is not one of the four recognised shapes it
// answers "not-a-call-shape-site" (match/​check both treat that the same as
// "keep scanning", never surfaced as a real abandonment); for a recognised
// shape it always resolves to either a rule + replacement or one of the
// named §7 refuse reasons.
import type { Expr, Stmt } from "../ast.ts";
import { isHelperCall, isRegisterName } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type CallShapeRule = "R3a" | "R3b" | "R3c" | "R3d";

export type RefuseReason = "dynamic-args" | "impure-callee" | "unproven-this" | "member-callee-with-undefined-this" | "explicit-new-target" | "duplicated-construct-callee" | "helper-arity" | "not-a-call-shape-site";

export interface CallShapeSite {
  readonly rule: CallShapeRule;
  readonly stmtIndex: number;
  /** The exact `call` node being replaced — identity, not shape, is how
   *  `rewrite`/`check` find it again inside `list[stmtIndex]`. */
  readonly target: Expr;
  readonly replacement: Expr;
}

export type CallShapeMatch = Match<readonly Stmt[], CallShapeSite>;

export type ClassifyResult = { readonly ok: true; readonly rule: CallShapeRule; readonly replacement: Expr } | { readonly ok: false; readonly reason: RefuseReason };

// ---------------------------------------------------------------------------
// §3 — the four recognised callee shapes.
// ---------------------------------------------------------------------------

/** `Reflect.apply`/`Reflect.construct` — `member(ident "Reflect", lit name,
 *  computed:false)` exactly (never by argument position). */
function isReflectMember(e: Expr, name: "apply" | "construct"): boolean {
  return e.k === "member" && !e.computed && e.obj.k === "ident" && e.obj.name === "Reflect" && e.prop.k === "lit" && e.prop.text === name;
}

type Variant = "apply" | "construct" | "helper-call" | "helper-apply";

function variantOf(e: Expr): Variant | null {
  if (e.k !== "call") return null;
  if (isReflectMember(e.callee, "apply")) return "apply";
  if (isReflectMember(e.callee, "construct")) return "construct";
  if (isHelperCall(e, "__hbc_b_functionPrototypeCall")) return "helper-call";
  if (isHelperCall(e, "__hbc_b_functionPrototypeApply")) return "helper-apply";
  return null;
}

// ---------------------------------------------------------------------------
// §4 common preconditions.
// ---------------------------------------------------------------------------

/** `e` is `{k:"array", elements}` with no `k:"seq"` element — the one shape
 *  R3a/R3b/R3c's argument-list operand may take (§4: a spread already
 *  materialised into an identifier, or an element that is itself a `seq`,
 *  means the arity is not statically enumerable at print time). `null` for
 *  anything else — the caller reports `dynamic-args`. */
function extractArgsArray(e: Expr): readonly Expr[] | null {
  if (e.k !== "array") return null;
  if (e.elements.some((el) => el.k === "seq")) return null;
  return e.elements;
}

/** `e` is `ident`, `lit`, or a `member` chain built only from `ident`/`lit`/
 *  further such `member`s (§4: "F is ident, or a member chain over
 *  ident/lit"). Anything containing a `call`, `new`, `assign` or `unary
 *  delete` — indeed anything but `member`/`ident`/`lit` at all — fails this,
 *  which is exactly the set of shapes able to reorder or duplicate an
 *  observable effect if evaluated an extra time. */
export function isSimpleCalleeChain(e: Expr): boolean {
  if (e.k === "ident" || e.k === "lit") return true;
  if (e.k !== "member") return false;
  return isSimpleCalleeChain(e.obj) && (!e.computed || isSimpleCalleeChain(e.prop));
}

/** Every `expr`-statement store `rX = value` reachable from `stmts`
 *  (including nested statement lists, excluding a nested `func`'s own
 *  frame) — copied from `global-access/match.ts`'s helper of the same
 *  purpose (D12a: a pass may not import a sibling pass's internals). */
function registerStoreValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
  const out: Expr[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) out.push(s.expr.value);
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
          break; // decl, break, continue, return, throw (no sub-list), func (separate frame)
      }
    }
  };
  visit(stmts);
  return out;
}

/** R3a's `T`: the literal `undefined`, or a register with exactly one write
 *  in `fnBody` whose value is the literal `undefined` (§4). Deliberately
 *  narrower than `global-access`'s `isProvenGlobal` (that one tolerates a
 *  *later* reuse of the register for scratch; this one cannot — a second
 *  write of *any* value, `undefined` or not, means the register no longer
 *  certifies "this call's `this` was always undefined" the way a single
 *  write does).
 *
 *  §4's literal text also asks for "no nested-closure read" on `t.name`
 *  (`identUses(fnBody, t.name).nested === 0`); that check is gone —
 *  `t.name` is a register (just proven above), and Hermes restarts register
 *  numbering per function, so a nested `func` body's own mention of the same
 *  number is provably that closure's own, unrelated local, never a read of
 *  *this* frame's `t`. A genuine capture would show up as a distinct,
 *  collision-free env-slot name (`_e<env>_<slot>`), never as the raw
 *  register — see `IdentUses.nested`'s doc in `../ast.ts`. This was the
 *  `21-iife-closures` gap recorded in `docs/STATUS.md`/`AGENT-LOG.md`: every
 *  `this`-holding register in a closure-bearing function coincidentally
 *  collides with some nested closure's own numbering, so the literal-§4
 *  check refused `unproven-this` on every single site there. */
export function isProvenUndefinedThis(t: Expr, fnBody: readonly Stmt[]): boolean {
  if (t.k === "lit" && t.text === "undefined") return true;
  if (t.k !== "ident" || !isRegisterName(t.name)) return false;
  const writes = registerStoreValues(fnBody, t.name);
  return writes.length === 1 && writes[0]!.k === "lit" && writes[0]!.text === "undefined";
}

// ---------------------------------------------------------------------------
// §4 per-rule classification.
// ---------------------------------------------------------------------------

function classifyReflectApply(node: Expr & { readonly k: "call" }, fnBody: readonly Stmt[]): ClassifyResult {
  const [F, T, arr] = node.args;
  if (node.args.length !== 3 || F === undefined || T === undefined || arr === undefined) return { ok: false, reason: "dynamic-args" };
  const args = extractArgsArray(arr);
  if (args === null) return { ok: false, reason: "dynamic-args" };

  if (F.k === "member") {
    if (!isSimpleCalleeChain(F)) return { ok: false, reason: "impure-callee" };
    const O = F.obj;
    const sameIdent = O.k === "ident" && T.k === "ident" && T.name === O.name;
    if (sameIdent) return { ok: true, rule: "R3b", replacement: { k: "call", callee: F, args } };
    if (isProvenUndefinedThis(T, fnBody)) return { ok: false, reason: "member-callee-with-undefined-this" };
    return { ok: false, reason: "unproven-this" };
  }

  if (!isSimpleCalleeChain(F)) return { ok: false, reason: "impure-callee" };
  if (!isProvenUndefinedThis(T, fnBody)) return { ok: false, reason: "unproven-this" };
  return { ok: true, rule: "R3a", replacement: { k: "call", callee: F, args } };
}

function classifyReflectConstruct(node: Expr & { readonly k: "call" }): ClassifyResult {
  const C = node.args[0];
  const arr = node.args[1];
  const NT = node.args[2];
  if (node.args.length < 2 || node.args.length > 3 || C === undefined || arr === undefined) return { ok: false, reason: "dynamic-args" };
  const args = extractArgsArray(arr);
  if (args === null) return { ok: false, reason: "dynamic-args" };
  if (!isSimpleCalleeChain(C)) return { ok: false, reason: "impure-callee" };
  if (NT !== undefined) {
    if (JSON.stringify(NT) !== JSON.stringify(C)) return { ok: false, reason: "explicit-new-target" };
    // Same syntactic new-target as the callee: `new C(args)` evaluates `C`
    // ONCE, but `Reflect.construct(C, args, C)` evaluates it TWICE (once as
    // target, once as new-target). Free only when `C` is an identifier/
    // register — re-reading an identifier is side-effect-free. A member
    // callee (`a.b`) is NOT free to re-evaluate: a getter or Proxy trap on
    // `b` would fire once instead of twice, an observable behaviour change
    // the recompute-and-compare `check` cannot see (it re-derives the same
    // verdict from the same rule, so it agrees with a bug in the rule
    // itself). See docs/reviews/M5-pass-4.md H1.
    if (C.k !== "ident") return { ok: false, reason: "duplicated-construct-callee" };
  }
  return { ok: true, rule: "R3c", replacement: { k: "new", callee: C, args } };
}

function classifyHelperCall(node: Expr & { readonly k: "call" }): ClassifyResult {
  if (node.args.length < 2) return { ok: false, reason: "helper-arity" };
  const [F, T, ...rest] = node.args;
  if (!isSimpleCalleeChain(F!)) return { ok: false, reason: "impure-callee" };
  const callee: Expr = { k: "member", obj: F!, prop: { k: "lit", text: "call" }, computed: false };
  return { ok: true, rule: "R3d", replacement: { k: "call", callee, args: [T!, ...rest] } };
}

function classifyHelperApply(node: Expr & { readonly k: "call" }): ClassifyResult {
  if (node.args.length !== 3) return { ok: false, reason: "helper-arity" };
  const [F, T, arr] = node.args;
  if (!isSimpleCalleeChain(F!)) return { ok: false, reason: "impure-callee" };
  const callee: Expr = { k: "member", obj: F!, prop: { k: "lit", text: "apply" }, computed: false };
  return { ok: true, rule: "R3d", replacement: { k: "call", callee, args: [T!, arr!] } };
}

/** Total over any `Expr`: recognises the four callee shapes and, for a
 *  recognised one, fully re-derives the verdict from `node`/`fnBody` alone —
 *  no captured `match` data is ever trusted (`check.ts` calls this again on
 *  `before`, exactly as `match` does). */
export function classifyNode(node: Expr, fnBody: readonly Stmt[]): ClassifyResult {
  const variant = variantOf(node);
  if (variant === null) return { ok: false, reason: "not-a-call-shape-site" };
  const call = node as Expr & { readonly k: "call" };
  switch (variant) {
    case "apply":
      return classifyReflectApply(call, fnBody);
    case "construct":
      return classifyReflectConstruct(call);
    case "helper-call":
      return classifyHelperCall(call);
    case "helper-apply":
      return classifyHelperApply(call);
  }
}

// ---------------------------------------------------------------------------
// §4 site enumeration — pre-order over one statement list, never crossing
// into a nested `Stmt[]` (a separate `stmtLists` site) or a nested `func`
// body (a separate frame).
// ---------------------------------------------------------------------------

/** The `Expr` fields directly on `s` (mirrors `global-access`/`expr-rebuild`'s
 *  own `topLevelExprFields`/`topLevelExprOf`). */
function exprFieldsOf(s: Stmt): readonly Expr[] {
  switch (s.k) {
    case "expr":
      return [s.expr];
    case "init":
      return [s.value];
    case "if":
      return [s.test];
    case "while":
      return s.test !== undefined ? [s.test] : [];
    case "do-while":
      return [s.test];
    case "for":
      return [s.init, s.test, s.update].filter((x): x is Expr => x !== null);
    case "return":
      return s.arg !== null ? [s.arg] : [];
    case "throw":
      return [s.arg];
    case "switch":
      return [s.disc];
    default:
      return []; // decl, break, continue, labeled, try, switch-body, func, iife: no own field
  }
}

export interface CandidateSite {
  readonly stmtIndex: number;
  readonly node: Expr;
}

function collectFromExpr(e: Expr, stmtIndex: number, out: CandidateSite[]): void {
  if (e.k === "call") out.push({ stmtIndex, node: e });
  switch (e.k) {
    case "member":
      collectFromExpr(e.obj, stmtIndex, out);
      if (e.computed) collectFromExpr(e.prop, stmtIndex, out);
      return;
    case "call":
    case "new":
      collectFromExpr(e.callee, stmtIndex, out);
      e.args.forEach((a) => collectFromExpr(a, stmtIndex, out));
      return;
    case "bin":
    case "logical":
      collectFromExpr(e.left, stmtIndex, out);
      collectFromExpr(e.right, stmtIndex, out);
      return;
    case "unary":
      collectFromExpr(e.arg, stmtIndex, out);
      return;
    case "assign":
      collectFromExpr(e.target, stmtIndex, out);
      collectFromExpr(e.value, stmtIndex, out);
      return;
    case "cond":
      collectFromExpr(e.test, stmtIndex, out);
      collectFromExpr(e.then, stmtIndex, out);
      collectFromExpr(e.else, stmtIndex, out);
      return;
    case "array":
      e.elements.forEach((x) => collectFromExpr(x, stmtIndex, out));
      return;
    case "object":
      e.props.forEach((p) => collectFromExpr(p.value, stmtIndex, out));
      return;
    case "seq":
      e.exprs.forEach((x) => collectFromExpr(x, stmtIndex, out));
      return;
    default:
      return; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

/** Every `call` node reachable from `list`, in pre-order, tagged with its
 *  owning statement's index — a `call` that is not one of the four
 *  recognised shapes is still collected (so a nested candidate inside a
 *  plain call's arguments is still found), `classifyNode` just answers
 *  `not-a-call-shape-site` for it. */
export function collectCandidates(list: readonly Stmt[]): readonly CandidateSite[] {
  const out: CandidateSite[] = [];
  list.forEach((s, stmtIndex) => {
    for (const field of exprFieldsOf(s)) collectFromExpr(field, stmtIndex, out);
  });
  return out;
}

export function match(list: readonly Stmt[], ctx: PassContext): CallShapeMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (const c of collectCandidates(list)) {
    const result = classifyNode(c.node, fnBody);
    if (result.ok) {
      return {
        root: list,
        nodes: [list],
        data: { rule: result.rule, stmtIndex: c.stmtIndex, target: c.node, replacement: result.replacement },
        at: { functionIndex: ctx.functionIndex, offset: c.stmtIndex },
      };
    }
  }
  return null;
}
