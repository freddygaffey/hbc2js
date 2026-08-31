// var-naming matcher — docs/LOWERING-CATALOGUE.md row R5,
// docs/specs/passes/07-var-naming.md §4.
//
// Site = the function-body root list only (`match` returns `null` unless
// `list === ctx.fnBody`): a register is function-scoped, so a per-sublist
// site could not see every def/use. `classifyAll` computes every register
// candidate's verdict in one pass (later candidates' `taken` set includes
// names already claimed by earlier winners in the same pass — PL-07, no
// cross-site state; `ctx.fnBody` is re-derived per site by the driver, so
// re-reading it after a rename already reflects the claim) and is exported
// so `check.ts` can re-derive the same verdict from `before` alone, and so
// unit tests can assert an exact refuse reason without going through the
// driver — the same split `fn-naming/match.ts` uses.
import type { Expr, Stmt } from "../ast.ts";
import { defUse, freeNames, isRegisterName, isSafeIdentifier, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { assignsTo, isIdentNamed, readsName, walkFrame } from "./frame.ts";

export interface RegisterSite {
  readonly from: string;
  readonly to: string;
}

export type VarNamingMatch = Match<readonly Stmt[], RegisterSite>;

export type RefuseReason = "reuse-conflict" | "globalthis-alias" | "no-heuristic" | "pool-exhausted" | "dedup-exhausted" | "reserved-word" | "emitter-name-class";

export type ClassifyResult = { readonly ok: true; readonly to: string } | { readonly ok: false; readonly reason: RefuseReason };

// §4.3 — the emitter-generated name classes a heuristic name must never
// collide with (copied, not imported — D12a; the same convention
// `fn-naming/match.ts`'s copy follows). `a\d+` is added here (not present in
// fn-naming's copy): spec §4.3 calls it out explicitly so a heuristic can
// never manufacture a param-shaped name.
const EMITTER_NAME_CLASS_RE = /^(_fn\d+|_e\d+_\d+|r\d+|__.*|_exc\d+|L\d+|__state\d+|a\d+)$/;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const INDUCTION_POOL = ["i", "j", "k", "l", "m", "n"] as const;

const ARRAY_METHODS = new Set(["push", "pop", "join", "length", "indexOf"]);

const COMPARISON_OPS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "instanceof", "in"]);

// A handful of common-noun abbreviations that read better than a literal
// lower-camel of the constructor name (spec §4.2 #4: "Error -> err, Foo ->
// foo"). Everything not in this table falls back to a plain lower-camel.
const CTOR_ABBREV: Readonly<Record<string, string>> = { Error: "err", TypeError: "err", RangeError: "err" };

// ---------------------------------------------------------------------------
// §4.3 — names already declared anywhere in the function (own copy, D12a;
// mirrors `fn-naming/match.ts`'s `declaredNames`).
// ---------------------------------------------------------------------------

export function declaredNames(stmts: readonly Stmt[]): Set<string> {
  const bound = new Set<string>();
  walk(stmts, {
    expr: (e) => {
      if (e.k === "func") {
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
  return bound;
}

// ---------------------------------------------------------------------------
// Frame-local def-value collection — mirrors `../ast.ts`'s `defUse` traversal
// exactly (so its count always agrees with `defUse(fnBody).get(rN).defs
// .length`), but returns each def's *value* expression instead of a
// statement index: the heuristics in §4.2 need to inspect what was assigned,
// not just how many times.
// ---------------------------------------------------------------------------

function collectDefValues(stmts: readonly Stmt[], name: string): Expr[] {
  const out: Expr[] = [];
  const visitExpr = (e: Expr): void => {
    switch (e.k) {
      case "assign":
        if (isIdentNamed(e.target, name)) out.push(e.value);
        else visitExpr(e.target);
        visitExpr(e.value);
        return;
      case "member":
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        return;
      case "call":
      case "new":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        return;
      case "bin":
      case "logical":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "unary":
        visitExpr(e.arg);
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
        return; // ident, lit, this, argumentsObject, func (separate frame)
    }
  };
  const visitStmts = (list: readonly Stmt[]): void => {
    for (const s of list) {
      switch (s.k) {
        case "expr":
          visitExpr(s.expr);
          break;
        case "init":
          if (s.name === name) out.push(s.value);
          visitExpr(s.value);
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
          break;
        case "throw":
          visitExpr(s.arg);
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
          break; // decl, func (separate frame), break, continue, directive, comment, raw
      }
    }
  };
  visitStmts(stmts);
  return out;
}

// ---------------------------------------------------------------------------
// §4.1/§4.2 shape predicates.
// ---------------------------------------------------------------------------

function isGlobalThisAlias(value: Expr): boolean {
  return value.k === "ident" && (value.name === "globalThis" || value.global === true);
}

function isArrayCtor(value: Expr): boolean {
  if (value.k === "array") return true;
  return value.k === "new" && value.callee.k === "ident" && value.callee.name === "Array";
}

function lowerCamel(name: string): string {
  return name.length === 0 ? name : name[0]!.toLowerCase() + name.slice(1);
}

/** §4.2 #4 — the callee-derived base for a `call`/`new` def, or `null` when
 *  the callee shape carries no usable name (a computed member, a call
 *  expression callee, …). "If the base equals the callee's own name (would
 *  shadow the function), fall to the -Result/numeric suffix in §4.3" needs
 *  no special-casing here: the callee's own name is always either free or
 *  declared in this frame (it is, after all, the very identifier being
 *  called), so it is already in `resolveBase`'s `taken` set and the ordinary
 *  collision suffix (`base2`, `base3`, …) fires on its own. */
function callResultBase(value: Expr): string | null {
  if (value.k === "call") {
    if (value.callee.k === "ident") return value.callee.name;
    if (value.callee.k === "member" && !value.callee.computed && value.callee.prop.k === "lit") return value.callee.prop.text;
    return null;
  }
  if (value.k === "new" && value.callee.k === "ident") {
    return CTOR_ABBREV[value.callee.name] ?? lowerCamel(value.callee.name);
  }
  return null;
}

function isTypeofExpr(e: Expr): boolean {
  return e.k === "unary" && e.op === "typeof ";
}

/** §4.2 #6 — a comparison, a logical combination, a `!` negation, or a
 *  `typeof … === …` chain. */
function isBooleanish(value: Expr): boolean {
  if (value.k === "logical") return true;
  if (value.k === "unary" && value.op === "!") return true;
  if (value.k === "bin") {
    if (COMPARISON_OPS.has(value.op)) return true;
    if ((value.op === "===" || value.op === "!==") && (isTypeofExpr(value.left) || isTypeofExpr(value.right))) return true;
  }
  return false;
}

function isBinPlusSelf(value: Expr, name: string): boolean {
  return value.k === "bin" && value.op === "+" && (isIdentNamed(value.left, name) || isIdentNamed(value.right, name));
}

function isStringLit(value: Expr): boolean {
  return value.k === "lit" && /^["'`]/.test(value.text);
}

/** §4.2 #1's whole-frame shape: a `for` node whose `init`/`update` both
 *  assign `name` (directly, or as a `seq` term — the shape `for.init`/
 *  `for.update` take per `src/emit/function.ts`'s `asExprs`) and whose
 *  `test` reads it. */
function isLoopInductionVar(stmts: readonly Stmt[], name: string): boolean {
  let found = false;
  walkFrame(stmts, {
    stmt: (s) => {
      if (s.k === "for" && s.init !== null && s.update !== null && assignsTo(s.init, name) && assignsTo(s.update, name) && readsName(s.test, name)) found = true;
    },
  });
  return found;
}

/** §4.2 #3's second route: `name` is the receiver of `.push`/`.pop`/
 *  `.join`/`.length`/`.indexOf` anywhere in the frame. */
function usedAsArrayReceiver(stmts: readonly Stmt[], name: string): boolean {
  let found = false;
  walkFrame(stmts, {
    expr: (e) => {
      if (e.k === "member" && !e.computed && isIdentNamed(e.obj, name) && e.prop.k === "lit" && ARRAY_METHODS.has(e.prop.text)) found = true;
    },
  });
  return found;
}

function isBareOrNegated(e: Expr, name: string): boolean {
  return isIdentNamed(e, name) || (e.k === "unary" && e.op === "!" && isIdentNamed(e.arg, name));
}

/** §4.2 #6's second half: `name` (bare, or negated with `!`) is read as the
 *  test of an `if`/`while`/`cond` (ternary) anywhere in the frame. */
function usedAsTest(stmts: readonly Stmt[], name: string): boolean {
  let found = false;
  walkFrame(stmts, {
    stmt: (s) => {
      if (s.k === "if" && isBareOrNegated(s.test, name)) found = true;
      else if (s.k === "while" && s.test !== undefined && isBareOrNegated(s.test, name)) found = true;
    },
    expr: (e) => {
      if (e.k === "cond" && isBareOrNegated(e.test, name)) found = true;
    },
  });
  return found;
}

// ---------------------------------------------------------------------------
// §4.3 — collision resolution.
// ---------------------------------------------------------------------------

function resolveBase(base: string, taken: ReadonlySet<string>): ClassifyResult {
  let candidate = base;
  if (taken.has(candidate)) {
    let next: string | null = null;
    for (let suffix = 2; suffix <= 9; suffix++) {
      const attempt = `${base}${suffix}`;
      if (!taken.has(attempt)) {
        next = attempt;
        break;
      }
    }
    if (next === null) return { ok: false, reason: "dedup-exhausted" };
    candidate = next;
  }
  if (!isSafeIdentifier(candidate)) return { ok: false, reason: "reserved-word" };
  if (EMITTER_NAME_CLASS_RE.test(candidate)) return { ok: false, reason: "emitter-name-class" };
  return { ok: true, to: candidate };
}

function resolveInductionBase(taken: ReadonlySet<string>): ClassifyResult {
  for (const cand of INDUCTION_POOL) {
    if (!taken.has(cand)) return { ok: true, to: cand };
  }
  return { ok: false, reason: "pool-exhausted" };
}

// ---------------------------------------------------------------------------
// §4.1 reuse gate + §4.2 heuristic priority, for one register.
// ---------------------------------------------------------------------------

function classifyRegister(fnBody: readonly Stmt[], name: string, taken: ReadonlySet<string>): ClassifyResult {
  const defValues = collectDefValues(fnBody, name);
  if (defValues.length === 0) return { ok: false, reason: "no-heuristic" };

  if (defValues.length === 1) {
    const value = defValues[0]!;
    if (isGlobalThisAlias(value)) return { ok: false, reason: "globalthis-alias" };
    if (isArrayCtor(value) || usedAsArrayReceiver(fnBody, name)) return resolveBase("arr", taken);
    const callBase = callResultBase(value);
    if (callBase !== null) return resolveBase(callBase, taken);
    if (isBooleanish(value) && usedAsTest(fnBody, name)) return resolveBase("ok", taken);
    return { ok: false, reason: "no-heuristic" };
  }

  // Multi-def: only the two whole-frame roles §4.1 recognises are licensed.
  if (defValues.length === 2 && isLoopInductionVar(fnBody, name)) return resolveInductionBase(taken);
  if (defValues.every((v) => isBinPlusSelf(v, name) || isStringLit(v)) && defValues.some((v) => isBinPlusSelf(v, name))) {
    return resolveBase("s", taken);
  }
  return { ok: false, reason: "reuse-conflict" };
}

// ---------------------------------------------------------------------------
// Driver-facing surface.
// ---------------------------------------------------------------------------

export interface CandidateResult {
  readonly name: string;
  readonly result: ClassifyResult;
}

/** Every surviving register in `fnBody`'s leading `decl`, classified in
 *  first-def order (spec §4.3: "the pool is drawn in first-def order" — an
 *  outer loop's counter is defined before an inner loop's, so it claims `i`
 *  first). A winner's `to` is reserved into `taken` immediately, so a later
 *  candidate in the same pass never collides with an earlier one's new name
 *  (no cross-site state, PL-07: this is recomputed fresh from `fnBody` on
 *  every call, which already reflects every rename applied so far). */
export function classifyAll(fnBody: readonly Stmt[]): readonly CandidateResult[] {
  const decl = fnBody.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  if (decl === undefined) return [];
  const du = defUse(fnBody);
  const candidates = decl.names
    .filter((n) => isRegisterName(n))
    .map((name) => ({ name, firstDef: Math.min(...(du.get(name)?.defs ?? [])) }))
    .filter((c) => Number.isFinite(c.firstDef))
    .sort((a, b) => a.firstDef - b.firstDef);

  const taken = new Set<string>([...freeNames(fnBody), ...declaredNames(fnBody)]);
  const results: CandidateResult[] = [];
  for (const c of candidates) {
    const result = classifyRegister(fnBody, c.name, taken);
    results.push({ name: c.name, result });
    if (result.ok) taken.add(result.to);
  }
  return results;
}

/** Re-derives the verdict for one register — the same classification
 *  `match` uses internally, exported so `check.ts` can recompute it from
 *  `before` alone and so unit tests can assert an exact refuse reason
 *  without going through the driver. */
export function classifySite(fnBody: readonly Stmt[], name: string): ClassifyResult {
  const found = classifyAll(fnBody).find((c) => c.name === name);
  return found?.result ?? { ok: false, reason: "no-heuristic" };
}

export function match(list: readonly Stmt[], ctx: PassContext): VarNamingMatch | null {
  if (list !== ctx.fnBody || ctx.module === undefined) return null;
  const winner = classifyAll(list).find((c) => c.result.ok);
  if (winner === undefined || !winner.result.ok) return null;
  const du = defUse(list).get(winner.name);
  const offset = du === undefined || du.defs.length === 0 ? 0 : Math.min(...du.defs);
  return { root: list, nodes: [list], data: { from: winner.name, to: winner.result.to }, at: { functionIndex: ctx.functionIndex, offset } };
}

export { EMITTER_NAME_CLASS_RE, IDENT_RE };
