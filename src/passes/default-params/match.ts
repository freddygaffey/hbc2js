// default-params matcher — docs/LOWERING-CATALOGUE.md row 24,
// docs/specs/passes/15-default-params.md, corrected per docs/PUSHBACK.md P-8.
//
// P-8: the spec's §2/§4 describe the guard as `if (rX !== U) {} else {
// …default… }`. That shape never reaches stage B. What actually survives
// every stage-A pass (label-clean's L2 refuses to collapse it because the
// guarding `if` is not the *last* statement of the labeled body) is one
// **labeled block per defaulted parameter**, in ascending order, at the
// head of the function body:
//
//   L0: {
//     rX = arguments[k];      // may also carry loads for *later* k's
//     if (rX !== U) {
//       break L0;
//     }
//     …default body, ending by assigning rX…
//     break L0;
//   }
//
// `U` is either the literal `undefined` or a register whose value — tracked
// forward through the scan, not merely "written once anywhere in the
// function" (a later, unrelated reuse of the same scratch register, once
// its job as the undefined-sentinel is over, is common and harmless: see
// `chainedDefaults`'s `r2`, reused for `","` right after the last guard) —
// is `undefined` at the point this guard reads it.
//
// Site = one statement list `L` (a `stmtLists` site of the *enclosing*
// function — the `func` node being rewritten is a member of `L`, not `L`
// itself: its own body is a separate `stmtLists` site, per `ast.ts`'s
// `stmtLists` doc). `classifyFunc` is exported so `check.ts` can re-derive
// the same defaults from `before` alone, and `rewrite.ts`/`check.ts` share
// `buildFunc`.
import type { Expr, Param, Stmt } from "../ast.ts";
import { freeNames, identUses, isPureStmt, isRegisterName, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

/** A `func` node reached either directly (`{k:"func"}` statement) or
 *  through one level of `init`/`assign` (an expression-form closure bound
 *  to a name) — both share the same `{ name, params, body }` shape for our
 *  purposes. */
export type FuncLike = { readonly name: string | null; readonly params: readonly Param[]; readonly body: readonly Stmt[] };

/** Find the `func` node carried by statement `s`, or `null`. Mirrors
 *  `freeNames`'s own two recognised shapes (a `func` statement, or a `func`
 *  expression as an `init`/`assign` value) plus the bare statement form. */
export function extractFunc(s: Stmt): FuncLike | null {
  if (s.k === "func") return s;
  if (s.k === "init" && s.value.k === "func") return s.value;
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "func") return s.expr.value;
  return null;
}

/** Rebuild `s` with its `func` node replaced by `F` — the exact inverse of
 *  `extractFunc`. */
function withFunc(s: Stmt, F: FuncLike): Stmt {
  if (s.k === "func") return { ...s, ...F, name: s.name };
  if (s.k === "init" && s.value.k === "func") return { ...s, value: { ...s.value, ...F, name: s.value.name } };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "func") return { ...s, expr: { ...s.expr, value: { ...s.expr.value, ...F, name: s.expr.value.name } } };
  return s;
}

export interface DefaultSite {
  /** 0-based parameter index (`F.params.length` at the time it was accepted). */
  readonly k: number;
  readonly rX: string;
  /** Index of the labeled block in `F.body` this default came from. */
  readonly labelIndex: number;
  readonly init: Expr;
}

export interface DefaultParamsSite {
  /** Index of the `func`-carrying member inside the matched list. */
  readonly stmtIndex: number;
  /** In ascending `k`, never empty (`match` returns `null` for empty). */
  readonly defaults: readonly DefaultSite[];
  /** See `ClassifyResult.consumed`. */
  readonly consumed: ReadonlySet<Stmt>;
}

export type DefaultParamsMatch = Match<readonly Stmt[], DefaultParamsSite>;

export type RefuseReason = "no-defaults" | "protocol-name" | "not-undefined-guard" | "param-register-reused" | "default-reads-body-state" | "non-expression-default" | "effect-before-default" | "generator-or-try-prologue" | "out-of-order" | "unlowerable-default";

// ---------------------------------------------------------------------------
// Per-statement shape recognition.
// ---------------------------------------------------------------------------

/** `rX = arguments[k]` (`k` a non-negative integer literal, `rX` a register
 *  name — `protocol-name` if it is not). */
function matchLoad(s: Stmt): { readonly reg: string; readonly k: number } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident") return null;
  const v = s.expr.value;
  if (v.k !== "member" || !v.computed || v.obj.k !== "argumentsObject" || v.prop.k !== "lit") return null;
  if (!/^\d+$/.test(v.prop.text)) return null;
  return { reg: s.expr.target.name, k: Number(v.prop.text) };
}

/** `if (rX !== U) { break <label> }` with an empty `else` — the guard for
 *  the labeled block named `label`. */
function matchGuard(s: Stmt, label: string): { readonly rX: string; readonly u: Expr } | null {
  if (s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return null;
  const br = s.then[0]!;
  if (br.k !== "break" || br.label !== label) return null;
  const t = s.test;
  if (t.k !== "bin" || t.op !== "!==" || t.left.k !== "ident" || !isRegisterName(t.left.name)) return null;
  return { rX: t.left.name, u: t.right };
}

/** Collapse the default body `stmts` (everything between the guard and the
 *  labeled block's own tail `break`) into a single `Expr`, per §5: the last
 *  statement must be `rX = E`; everything before it must be a plain `expr`
 *  statement (no `decl`, no control flow), folded into a leading `seq`. */
function collapseToInit(stmts: readonly Stmt[], rX: string): Expr | null {
  if (stmts.length === 0) return null;
  const last = stmts[stmts.length - 1]!;
  if (last.k !== "expr" || last.expr.k !== "assign" || last.expr.target.k !== "ident" || last.expr.target.name !== rX) return null;
  const lead = stmts.slice(0, -1);
  if (!lead.every((s) => s.k === "expr")) return null;
  if (lead.length === 0) return last.expr.value;
  return { k: "seq", exprs: [...lead.map((s) => (s as Extract<Stmt, { k: "expr" }>).expr), last.expr.value] };
}

/**
 * The other shape §5 needs: `stmts` collapses fine as a comma expression
 * *except* that one or more registers it produces and then re-reads
 * (`localTemps` — `withSideEffectDefault`'s counter accumulator, `greet`'s
 * one-shot `r1 = "!"`) have nowhere legal to live as a bare identifier.
 * A parameter default is evaluated in ES's *parameter* environment, a
 * separate scope from the function's own `let`-declared *body* environment
 * whenever the parameter list is non-simple (has any default) — so a `let`
 * this rung leaves behind in the body (`pruneRegisterDecls`, patched for
 * this same reason) does **not** cover a bare register read from inside a
 * default (docs/BUGS.md's default-params-prune-leak row): in non-strict
 * code such a read/write silently becomes an implicit global instead of a
 * `ReferenceError`, which is exactly how this rung first shipped broken.
 * The general, always-legal fix: give the temporary its own real scope, a
 * zero-argument IIFE with a genuine `let` declaring exactly `localTemps`.
 * `rX` itself is never one of them — the last statement's `return`
 * replaces its `rX = E` assignment, so nothing needs to reference `rX` as a
 * variable at all inside the IIFE. */
function collapseToIife(stmts: readonly Stmt[], rX: string, localTemps: ReadonlySet<string>): Expr | null {
  if (stmts.length === 0) return null;
  const last = stmts[stmts.length - 1]!;
  if (last.k !== "expr" || last.expr.k !== "assign" || last.expr.target.k !== "ident" || last.expr.target.name !== rX) return null;
  const lead = stmts.slice(0, -1);
  if (!lead.every((s) => s.k === "expr")) return null;
  const body: Stmt[] = [];
  if (localTemps.size > 0) body.push({ k: "decl", kind: "let", names: [...localTemps] });
  body.push(...lead);
  body.push({ k: "return", arg: last.expr.value });
  const func: Expr = { k: "func", name: null, params: [], body };
  return { k: "call", callee: func, args: [] };
}

/** Every register name read by `e` — an assignment's own `ident` target is
 *  never a read of that name (it is the write); a `member` assignment's
 *  `obj`/`prop` are. Never descends into a nested `func` body (the same
 *  frame boundary `identUses`/`registerUses` observe): a register found
 *  there is a different function's own local, not this one's. */
function exprRegisterReads(e: Expr): readonly string[] {
  const out: string[] = [];
  const visit = (x: Expr): void => {
    switch (x.k) {
      case "ident":
        if (isRegisterName(x.name)) out.push(x.name);
        return;
      case "assign":
        if (x.target.k === "ident") visit(x.value);
        else {
          visit(x.target);
          visit(x.value);
        }
        return;
      case "member":
        visit(x.obj);
        if (x.computed) visit(x.prop);
        return;
      case "call":
      case "new":
        visit(x.callee);
        x.args.forEach(visit);
        return;
      case "bin":
      case "logical":
        visit(x.left);
        visit(x.right);
        return;
      case "unary":
        visit(x.arg);
        return;
      case "cond":
        visit(x.test);
        visit(x.then);
        visit(x.else);
        return;
      case "array":
        x.elements.forEach(visit);
        return;
      case "object":
        x.props.forEach((p) => visit("k" in p ? p.arg : p.value));
        return;
      case "seq":
        x.exprs.forEach(visit);
        return;
      case "template":
        x.exprs.forEach(visit);
        return;
      case "tagged":
        visit(x.tag);
        visit(x.quasi);
        return;
      default:
        return; // lit, this, argumentsObject, func (separate frame), jsx
    }
  };
  visit(e);
  return out;
}

/** Rebuilds `e`, replacing every read of a register in `values` with its
 *  literal value — never touches an assignment's own `ident` target (mirrors
 *  `exprRegisterReads`'s boundary), never descends into a nested `func`
 *  body. A prologue constant (`r4 = 1;`, spilled once, ahead of every
 *  guard, and shared by more than one default — `chainedDefaults`'s `r4`)
 *  would otherwise dangle: its establishing statement sits in a labeled
 *  block this rung deletes, but the value itself has no side effect and no
 *  control-flow dependency, so substituting it in place is exact — sound
 *  regardless of which defaults end up firing at a given call, unlike
 *  trying to re-attach the assignment to any one particular default (a
 *  later default may need the constant even when the default that would
 *  carry the assignment does not itself fire). */
function substituteConstants(e: Expr, values: ReadonlyMap<string, Expr>): Expr {
  const go = (x: Expr): Expr => {
    switch (x.k) {
      case "ident": {
        const v = isRegisterName(x.name) ? values.get(x.name) : undefined;
        return v ?? x;
      }
      case "assign": {
        const value = go(x.value);
        if (x.target.k === "ident") return value === x.value ? x : { ...x, value };
        const target = go(x.target);
        return target === x.target && value === x.value ? x : { ...x, target, value };
      }
      case "member": {
        const obj = go(x.obj);
        const prop = x.computed ? go(x.prop) : x.prop;
        return obj === x.obj && prop === x.prop ? x : { ...x, obj, prop };
      }
      case "call":
      case "new": {
        const callee = go(x.callee);
        const args = x.args.map(go);
        return callee === x.callee && args.every((a, i) => a === x.args[i]) ? x : { ...x, callee, args };
      }
      case "bin":
      case "logical": {
        const left = go(x.left);
        const right = go(x.right);
        return left === x.left && right === x.right ? x : { ...x, left, right };
      }
      case "unary": {
        const arg = go(x.arg);
        return arg === x.arg ? x : { ...x, arg };
      }
      case "cond": {
        const test = go(x.test);
        const then = go(x.then);
        const els = go(x.else);
        return test === x.test && then === x.then && els === x.else ? x : { ...x, test, then, else: els };
      }
      case "array": {
        const elements = x.elements.map(go);
        return elements.every((el, i) => el === x.elements[i]) ? x : { ...x, elements };
      }
      case "object": {
        const props = x.props.map((p) => ("k" in p ? { ...p, arg: go(p.arg) } : { ...p, value: go(p.value) }));
        return props.every((p, i) => ("k" in p ? p.arg === (x.props[i] as { arg: unknown }).arg : p.value === (x.props[i] as { value: unknown }).value)) ? x : { ...x, props };
      }
      case "seq": {
        const exprs = x.exprs.map(go);
        return exprs.every((e2, i) => e2 === x.exprs[i]) ? x : { ...x, exprs };
      }
      case "template": {
        const exprs = x.exprs.map(go);
        return exprs.every((e2, i) => e2 === x.exprs[i]) ? x : { ...x, exprs };
      }
      default:
        return x; // lit, this, argumentsObject, func (separate frame), jsx, tagged
    }
  };
  return go(e);
}

/** Is `F` the module wrapper (`_fn0`, spec §3 "must not touch")? Recognised
 *  by name — `src/emit/function.ts` always calls it `_fn0`. */
function isModuleWrapper(F: FuncLike): boolean {
  return F.name === "_fn0";
}

// ---------------------------------------------------------------------------
// The whole-function scan (§4, re-derived for the labeled-block idiom).
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  /** In ascending `k`. */
  readonly defaults: readonly DefaultSite[];
  /**
   * Every guard-`if`, raw (pre-substitution) default-body statement, and
   * trailing `break` an accepted default consumed, by reference identity
   * into `F.body`. `buildFunc` needs this to tell a consumed statement
   * apart from a *leftover* one sharing the same labeled block — a prologue
   * constant bunched into an earlier default's block but read only by
   * un-promoted code later in the function (`38-destructuring-object`'s
   * `greet`: `r0 = "Hello"`, spilled inside the same block as the object
   * parameter's own `= {}` default, but only ever read by the *nested*
   * destructuring guard this rung correctly leaves alone) must survive as
   * an ordinary statement, not disappear with the block that housed it.
   */
  readonly consumed: ReadonlySet<Stmt>;
}

/**
 * Recomputes every accepted default for `F`, from `F` alone — the function
 * `match` uses internally and `check.ts` re-derives from `before`. Always
 * returns a (possibly empty) prefix: a guard that fails a precondition
 * stops the scan rather than discarding what came before it (§4's
 * "out-of-order" rule — a prefix is a valid, smaller match).
 */
export function classifyFunc(F: FuncLike): ClassifyResult {
  const consumed = new Set<Stmt>();
  if (isModuleWrapper(F)) return { defaults: [], consumed };
  const B = F.body;
  const n = F.params.length;
  const loadOf = new Map<number, string>();
  const kOf = new Map<string, number>();
  const regState = new Map<string, "undefined" | "other">();
  // Registers the compiler spills a plain literal into during the prologue's
  // pure prefix (`r4 = 1;`, alongside the `U` sentinel) — shared scratch
  // constants, not function-body state, so a default body reading one is no
  // different from reading `U` itself.
  const constantValue = new Map<string, Expr>();
  const defaults: DefaultSite[] = [];
  let next = n;

  for (let i = 0; i < B.length; i++) {
    const s = B[i]!;
    if (s.k === "comment" || s.k === "decl") continue; // the register block / fn# comment precede the prologue, not part of it
    if (s.k !== "labeled") break; // the prologue is a contiguous run of labeled blocks at the head of B
    const label = s.label;
    const body = s.body;
    let guardIdx = -1;
    let rX: string | null = null;
    let u: Expr | null = null;
    let effectBeforeDefault = false;
    for (let j = 0; j < body.length; j++) {
      const st = body[j]!;
      const load = matchLoad(st);
      if (load !== null) {
        if (!isRegisterName(load.reg)) return { defaults, consumed }; // protocol-name
        loadOf.set(load.k, load.reg);
        kOf.set(load.reg, load.k);
        continue;
      }
      if (isPureStmt(st) && st.k === "expr" && st.expr.k === "assign" && st.expr.target.k === "ident") {
        const target = st.expr.target.name;
        regState.set(target, st.expr.value.k === "lit" && st.expr.value.text === "undefined" ? "undefined" : "other");
        if (st.expr.value.k === "lit") constantValue.set(target, st.expr.value);
        continue;
      }
      const guard = matchGuard(st, label);
      if (guard !== null) {
        guardIdx = j;
        rX = guard.rX;
        u = guard.u;
        break;
      }
      // Anything else before a guard is found is a genuine effect the
      // scan cannot jump over (§4 precondition 5) — stop here, not just
      // at this block: a statement this shape has no defined ordering
      // relative to whatever default would follow.
      effectBeforeDefault = true;
      break;
    }
    if (effectBeforeDefault || guardIdx === -1) break;

    const uOk = (u!.k === "lit" && u!.text === "undefined") || (u!.k === "ident" && isRegisterName(u!.name) && regState.get(u!.name) === "undefined" && identUses(B, u!.name).nested === 0);
    if (!uOk) break; // not-undefined-guard

    const k = kOf.get(rX!);
    if (k === undefined || k !== next) break; // no load for this register, or out-of-order

    const rest = body.slice(guardIdx + 1);
    const tail = rest[rest.length - 1];
    if (rest.length === 0 || tail === undefined || tail.k !== "break" || tail.label !== label) break; // not a tail break
    const rawDefaultBodyStmts = rest.slice(0, -1);

    // default-reads-body-state (§4 precondition 3) and prologue-constant
    // folding, in one progressive pass (program order matters for both): a
    // register read in the default body must be `rX` itself, an
    // earlier-accepted default's register, a prologue constant *not yet
    // locally shadowed*, or a register this *same* default body already
    // produced (a local temporary the collapsed `seq` computes and consumes
    // itself, e.g. `withSideEffectDefault`'s counter — or `greet`'s own
    // `r1`, first the `undefined` sentinel, later reassigned `"!"` inside
    // this very default body: reads after that reassignment must see the
    // new value, not the stale constant). `registerUses` alone cannot tell
    // a read of a value this sequence just produced apart from a read of
    // outside state (both are just reads of some `rN`), so this walks
    // statements in order instead, substituting each still-live prologue
    // constant as it goes (`substituteConstants`'s own doc explains why
    // substitution, not re-attachment, is the sound fix for a constant
    // shared by more than one default — `chainedDefaults`'s `r4`) and
    // dropping a register from the substitution table the moment this body
    // reassigns it.
    const allowed = new Set([...defaults.map((d) => d.rX), rX!]);
    const produced = new Set<string>();
    let liveConstants = constantValue;
    let readsBodyState = false;
    const defaultBodyStmts: Stmt[] = [];
    for (const st of rawDefaultBodyStmts) {
      if (st.k !== "expr") {
        readsBodyState = true;
        break;
      }
      const substituted = substituteConstants(st.expr, liveConstants);
      for (const name of exprRegisterReads(substituted)) {
        if (!allowed.has(name) && !produced.has(name)) readsBodyState = true;
      }
      if (substituted.k === "assign" && substituted.target.k === "ident") {
        // Only a register can ever need an IIFE-local `let` (`localTemps`,
        // below): a non-register target (an env slot like `_e0_0`, a
        // helper-shared name) is a real captured variable from an ancestor
        // scope and must keep referring to *that* binding, never a fresh
        // shadow — `withSideEffectDefault`'s own counter would silently
        // reset to `undefined` on every call otherwise.
        if (isRegisterName(substituted.target.name)) produced.add(substituted.target.name);
        if (liveConstants.has(substituted.target.name)) {
          liveConstants = new Map(liveConstants);
          liveConstants.delete(substituted.target.name);
        }
      }
      defaultBodyStmts.push(substituted === st.expr ? st : { ...st, expr: substituted });
    }
    if (readsBodyState) break;

    const localTemps = new Set(produced);
    localTemps.delete(rX!);
    const init = localTemps.size === 0 ? collapseToInit(defaultBodyStmts, rX!) : collapseToIife(defaultBodyStmts, rX!, localTemps);
    if (init === null) break; // unlowerable-default

    // param-register-reused (§4 precondition 2): within the prologue itself
    // (up to and including this labeled block) `rX` must have exactly two
    // writes — the load and the default's own final assignment. A write to
    // `rX` *after* the prologue (the ordinary ES equivalent of
    // `function f(a) { a = a + 1; return a; }`, `chainedDefaults`'s own
    // `r0 = r0 + r2 + r3 + r2 + r1;` accumulator) is unrelated: by the time
    // it runs, every default has already resolved, so it is never a sign
    // this register was doing double duty *during* defaulting.
    const prologueSoFar = B.slice(0, i + 1);
    const uses = identUses(prologueSoFar, rX!);
    if (uses.nested !== 0) break;
    if (uses.writes !== 2) break;

    let nonExpressionDefault = false;
    walk(defaultBodyStmts, {
      expr: (e) => {
        if (e.k === "func") for (const nm of freeNames(e.body)) if (isRegisterName(nm)) nonExpressionDefault = true;
      },
    });
    if (nonExpressionDefault) break;

    // generator-or-try-prologue: no `__pc`/`__exc` write anywhere in the
    // accepted prologue run so far.
    if (identUses(B.slice(0, i + 1), "__pc").writes > 0 || identUses(B.slice(0, i + 1), "__exc").writes > 0) break;

    consumed.add(body[guardIdx]!);
    for (const st of rawDefaultBodyStmts) consumed.add(st);
    consumed.add(tail);

    defaults.push({ k, rX: rX!, labelIndex: i, init });
    next++;
  }
  return { defaults, consumed };
}

/** §5's writer, shared by `rewrite.ts` and `check.ts` (the latter reuses it
 *  the same way `expr-rebuild/check.ts` reuses its own `rewrite`: a pure
 *  function of `(F, defaults, consumed)`, so calling it again from `before`
 *  alone reproduces the real writer's output exactly).
 *
 *  A removed labeled block is not simply deleted: every statement in it that
 *  is neither a `consumed` guard/default-body/break nor the load of a
 *  register being promoted (`rXs`) is a *leftover* — a prologue statement
 *  the block happened to house (another default's future load in v94's
 *  bunched-load style, or a plain constant only the surviving body reads,
 *  `38-destructuring-object`'s `greet`) — and survives, unwrapped from the
 *  label, in its original position and order. */
export function buildFunc(F: FuncLike, defaults: readonly DefaultSite[], consumed: ReadonlySet<Stmt>): FuncLike {
  const newParams: readonly Param[] = [...F.params, ...defaults.map((d) => ({ name: d.rX, init: d.init }))];
  const removedLabels = new Set(defaults.map((d) => d.labelIndex));
  const rXs = new Set(defaults.map((d) => d.rX));
  const body: Stmt[] = [];
  F.body.forEach((s, i) => {
    if (removedLabels.has(i) && s.k === "labeled") {
      for (const st of s.body) {
        const load = matchLoad(st);
        if (load !== null && rXs.has(load.reg)) continue; // promoted: folded into the parameter itself
        if (consumed.has(st)) continue; // this default's own guard/body/break
        body.push(st); // leftover: unwrap, keep, in place
      }
      return;
    }
    if (s.k === "decl" && s.names.some((n) => rXs.has(n))) {
      const names = s.names.filter((n) => !rXs.has(n));
      if (names.length === 0) return;
      body.push({ ...s, names });
      return;
    }
    body.push(s);
  });
  return { ...F, params: newParams, body };
}

export function match(list: readonly Stmt[], ctx: PassContext): DefaultParamsMatch | null {
  for (let i = 0; i < list.length; i++) {
    const F = extractFunc(list[i]!);
    if (F === null) continue;
    const { defaults, consumed } = classifyFunc(F);
    if (defaults.length === 0) continue;
    return { root: list, nodes: [list], data: { stmtIndex: i, defaults, consumed }, at: { functionIndex: ctx.functionIndex, offset: i } };
  }
  return null;
}

export function rewriteList(list: readonly Stmt[], site: DefaultParamsSite): readonly Stmt[] {
  const s = list[site.stmtIndex]!;
  const F = extractFunc(s);
  if (F === null) return list; // unreachable: `site` was derived from this very list
  const F2 = buildFunc(F, site.defaults, site.consumed);
  return list.map((m, i) => (i === site.stmtIndex ? withFunc(m, F2) : m));
}
