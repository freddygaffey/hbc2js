// var-naming matcher — docs/LOWERING-CATALOGUE.md row R5,
// docs/specs/passes/07-var-naming.md §4.
//
// Site = the function-body root list only (`match` returns `null` unless
// `list === ctx.fnBody`): a register is function-scoped, so a per-sublist
// site could not see every def/use. `classifyAll` computes every register
// candidate's verdict from ONE frame-local walk (`collectFacts`) — every
// def's value, the induction-loop defs, the array-receiver and test-position
// uses, per register, all at once — and is exported so `check.ts` can
// re-derive the same verdict from `before` alone, and so unit tests can
// assert an exact refuse reason without going through the driver — the same
// split `fn-naming/match.ts` uses.
//
// One match carries **every** qualifying rename in the frame (spec 05 §4's
// "batched" convention, which `fn-naming` adopted for docs/PUSHBACK.md P-1):
// the verdicts are independent of one another except through the `taken`
// set, which is threaded through the candidates in first-def order exactly
// as a one-per-iteration driver loop would have done (a later candidate
// sees every earlier winner's name as taken), so the batched output is the
// same as the per-iteration output at O(B) instead of O(K²·B) — K
// candidates re-classified, each with whole-body walks, after every one of
// K splices.
import type { Expr, Stmt } from "../ast.ts";
import { freeNames, isRegisterName, isSafeIdentifier, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { assignedNames, isIdentNamed, readsName, walkFrame } from "./frame.ts";

/** One `rN` → `to` rename. */
export interface RegisterRename {
  readonly from: string;
  readonly to: string;
}

/** The site's data: every qualifying rename in the frame, in first-def
 *  order (never empty — `match` returns `null` instead). */
export interface RegisterSite {
  readonly renames: readonly RegisterRename[];
}

export type VarNamingMatch = Match<readonly Stmt[], RegisterSite>;

export type RefuseReason = "reuse-conflict" | "globalthis-alias" | "no-heuristic" | "pool-exhausted" | "dedup-exhausted" | "reserved-word" | "emitter-name-class";

export type ClassifyResult = { readonly ok: true; readonly to: string } | { readonly ok: false; readonly reason: RefuseReason };

// §4.3 — the emitter-generated name classes a heuristic name must never
// collide with (copied, not imported — D12a; the same convention
// `fn-naming/match.ts`'s copy follows). `a\d+` is added here (not present in
// fn-naming's copy): spec §4.3 calls it out explicitly so a heuristic can
// never manufacture a param-shaped name.
// F15 (docs/specs/passes/19-reg-split.md §3.1): `r\d+(_\d+)?` so a heuristic
// name can never collide with a `reg-split` web variable either.
const EMITTER_NAME_CLASS_RE = /^(_fn\d+|_e\d+_\d+|r\d+(_\d+)?|__.*|_exc\d+|L\d+|__state\d+|a\d+)$/;

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
        for (const param of e.params) bound.add(param.name);
      }
    },
    stmt: (s) => {
      if (s.k === "decl") for (const n of s.names) bound.add(n);
      else if (s.k === "init") bound.add(s.name);
      else if (s.k === "try") bound.add(s.param);
      else if (s.k === "func") {
        bound.add(s.name);
        for (const param of s.params) bound.add(param.name);
      }
    },
  });
  return bound;
}

// ---------------------------------------------------------------------------
// The one frame-local walk — every fact §4.1/§4.2 read, for every register.
// ---------------------------------------------------------------------------

/** What one register does in its own frame. `defValues` is every def's
 *  `value` in walk order (an `assign` whose target is the register, or an
 *  `init` declaring it — the same events `../ast.ts`'s `defUse` counts, so
 *  `defValues.length === defUse(fnBody).get(rN).defs.length`);
 *  `inductionDefs` are the members of `defValues` that are a `for` head's
 *  init/update of a loop whose test reads the register (§4.2 #1);
 *  `firstDef` is the pre-order statement index of the first def (§4.3's
 *  "first-def order"). */
interface RegisterFacts {
  readonly defValues: Expr[];
  readonly inductionDefs: Set<Expr>;
  arrayReceiver: boolean;
  usedAsTest: boolean;
  firstDef: number;
}

function collectFacts(fnBody: readonly Stmt[]): Map<string, RegisterFacts> {
  const facts = new Map<string, RegisterFacts>();
  const factsFor = (name: string): RegisterFacts => {
    let f = facts.get(name);
    if (f === undefined) {
      f = { defValues: [], inductionDefs: new Set(), arrayReceiver: false, usedAsTest: false, firstDef: Number.POSITIVE_INFINITY };
      facts.set(name, f);
    }
    return f;
  };
  let stmtIndex = -1;
  const def = (name: string, value: Expr): void => {
    if (!isRegisterName(name)) return;
    const f = factsFor(name);
    f.defValues.push(value);
    if (stmtIndex < f.firstDef) f.firstDef = stmtIndex;
  };
  // §4.2 #6's second half: the register, bare or `!`-negated, *is* the test.
  const testRead = (e: Expr): void => {
    const name = e.k === "ident" ? e.name : e.k === "unary" && e.op === "!" && e.arg.k === "ident" ? e.arg.name : null;
    if (name !== null && isRegisterName(name)) factsFor(name).usedAsTest = true;
  };
  const inductionOf = (s: Stmt & { k: "for" }): void => {
    if (s.init === null || s.update === null) return;
    const initNames = assignedNames(s.init);
    const updateNames = new Set(assignedNames(s.update));
    for (const name of initNames) {
      if (!isRegisterName(name) || !updateNames.has(name) || !readsName(s.test, name)) continue;
      const f = factsFor(name);
      for (const head of [s.init, s.update]) {
        const terms = head.k === "seq" ? head.exprs : [head];
        for (const t of terms) if (t.k === "assign" && isIdentNamed(t.target, name)) f.inductionDefs.add(t.value);
      }
    }
  };
  walkFrame(fnBody, {
    stmt: (s) => {
      stmtIndex++;
      switch (s.k) {
        case "init":
          def(s.name, s.value);
          break;
        case "if":
          testRead(s.test);
          break;
        case "while":
          if (s.test !== undefined) testRead(s.test);
          break;
        case "for":
          inductionOf(s);
          break;
        default:
          break;
      }
    },
    expr: (e) => {
      switch (e.k) {
        case "assign":
          if (e.target.k === "ident") def(e.target.name, e.value);
          break;
        case "member":
          if (!e.computed && e.obj.k === "ident" && isRegisterName(e.obj.name) && e.prop.k === "lit" && ARRAY_METHODS.has(e.prop.text)) factsFor(e.obj.name).arrayReceiver = true;
          break;
        case "cond":
          testRead(e.test);
          break;
        default:
          break;
      }
    },
  });
  return facts;
}

// ---------------------------------------------------------------------------
// §4.1/§4.2 shape predicates on a def value.
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
  if (!IDENT_RE.test(candidate) || !isSafeIdentifier(candidate)) return { ok: false, reason: "reserved-word" };
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
// §4.1 reuse gate + §4.2 heuristic priority, for one register's facts.
// ---------------------------------------------------------------------------

function classifyRegister(name: string, f: RegisterFacts, taken: ReadonlySet<string>): ClassifyResult {
  const defs = f.defValues;
  if (defs.length === 0) return { ok: false, reason: "no-heuristic" };

  if (defs.length === 1) {
    const value = defs[0]!;
    if (isGlobalThisAlias(value)) return { ok: false, reason: "globalthis-alias" };
    if (isArrayCtor(value) || f.arrayReceiver) return resolveBase("arr", taken);
    const callBase = callResultBase(value);
    if (callBase !== null) return resolveBase(callBase, taken);
    if (isBooleanish(value) && f.usedAsTest) return resolveBase("ok", taken);
    return { ok: false, reason: "no-heuristic" };
  }

  // Multi-def: only the two whole-frame roles §4.1 recognises are licensed —
  // every def must be one loop's induction init/update (#1), or every def a
  // `+`-chain reading the register itself / a string literal seed (#5).
  if (defs.every((v) => f.inductionDefs.has(v))) return resolveInductionBase(taken);
  if (defs.every((v) => isBinPlusSelf(v, name) || isStringLit(v)) && defs.some((v) => isBinPlusSelf(v, name))) {
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
 *  candidate never collides with an earlier one's new name. One frame walk
 *  (`collectFacts`) plus one `freeNames`/`declaredNames` pair, however many
 *  candidates there are. */
export function classifyAll(fnBody: readonly Stmt[]): readonly CandidateResult[] {
  const decl = fnBody.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  if (decl === undefined) return [];
  const facts = collectFacts(fnBody);
  const candidates = decl.names
    .filter((n) => isRegisterName(n))
    .map((name) => ({ name, facts: facts.get(name) ?? { defValues: [], inductionDefs: new Set<Expr>(), arrayReceiver: false, usedAsTest: false, firstDef: Number.POSITIVE_INFINITY } }))
    .sort((a, b) => a.facts.firstDef - b.facts.firstDef);

  const taken = new Set<string>([...freeNames(fnBody), ...declaredNames(fnBody)]);
  const results: CandidateResult[] = [];
  for (const c of candidates) {
    const result = classifyRegister(c.name, c.facts, taken);
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
  const renames: RegisterRename[] = [];
  for (const c of classifyAll(list)) if (c.result.ok) renames.push({ from: c.name, to: c.result.to });
  if (renames.length === 0) return null;
  const decl = list.findIndex((s) => s.k === "decl");
  return { root: list, nodes: [list], data: { renames }, at: { functionIndex: ctx.functionIndex, offset: decl < 0 ? 0 : decl } };
}

export { EMITTER_NAME_CLASS_RE, IDENT_RE };
