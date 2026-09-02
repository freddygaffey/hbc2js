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

// §9 Q4 — widened from the original five: every added name is an
// `Array.prototype` method with no same-named method on `String.prototype`
// or `Object.prototype` (checked against MDN's method lists), so adding it
// never turns a string/plain-object receiver into a false "arr" — the same
// honesty bar the original five were held to. Deliberately excludes
// `slice`/`concat`/`includes` (both `Array` and `String` have them) even
// though they are common: ambiguous evidence must not be spent on a wider
// net, per the brief's "never lie" rule.
const ARRAY_METHODS = new Set(["push", "pop", "join", "length", "indexOf", "shift", "unshift", "splice", "forEach", "map", "filter", "reduce", "reduceRight", "sort", "reverse", "flat", "flatMap", "find", "findIndex", "fill", "some", "every"]);

const COMPARISON_OPS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "instanceof", "in"]);

// §9 Q4 — the ordering subset of `COMPARISON_OPS`: equality/`instanceof`/`in`
// say nothing about "one side is a bound", only `<`/`<=`/`>`/`>=` do.
const ORDERING_OPS = new Set(["<", "<=", ">", ">="]);

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
  // Compound upgrade (docs/specs/passes/19-reg-split.md §9 Q4): the register
  // is the `obj` of a computed member read/write (`r6[r0]`) anywhere in the
  // frame, weaker evidence than `arrayReceiver`'s named-method call — a
  // dict-shaped object subscripted by a non-numeric key is just as likely,
  // so this earns the more neutral base `list`, and only when nothing
  // stronger (an explicit `Array`/method-call) already fired.
  indexReceiver: boolean;
  usedAsTest: boolean;
  // §9 Q4 "single-literal-init … from the literal's role where safe": the
  // register is read as one operand of a `<`/`<=`/`>`/`>=` comparison
  // anywhere in the frame (a loop test's bound, a guard's threshold, …).
  // Combined with a bare numeric-literal def this is the "loop bound"
  // shape (`r9 = 10; while (i < r9) …`) — evidence that is honest about
  // the register's *role* (a threshold) without guessing *what* it counts.
  comparisonOperand: boolean;
  firstDef: number;
}

function collectFacts(fnBody: readonly Stmt[]): Map<string, RegisterFacts> {
  const facts = new Map<string, RegisterFacts>();
  const factsFor = (name: string): RegisterFacts => {
    let f = facts.get(name);
    if (f === undefined) {
      f = { defValues: [], inductionDefs: new Set(), arrayReceiver: false, indexReceiver: false, usedAsTest: false, comparisonOperand: false, firstDef: Number.POSITIVE_INFINITY };
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
          if (e.computed && e.obj.k === "ident" && isRegisterName(e.obj.name)) factsFor(e.obj.name).indexReceiver = true;
          break;
        case "cond":
          testRead(e.test);
          break;
        case "bin":
          if (ORDERING_OPS.has(e.op)) {
            for (const side of [e.left, e.right]) if (side.k === "ident" && isRegisterName(side.name)) factsFor(side.name).comparisonOperand = true;
          }
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
// Compound upgrade (docs/specs/passes/19-reg-split.md §9 Q4) — the new
// heuristics a reg-split web makes safe to add: each reads only the def's
// own shape (never a neighbouring register's *name*, per D23's forward
// rule), so they are as sound pre- or post-split. "Never lie" (the brief):
// every base below is either the literal source text (an alias) or a
// program-supplied word (a property/callee name) — never invented.
// ---------------------------------------------------------------------------

function isBooleanLit(value: Expr): boolean {
  return value.k === "lit" && (value.text === "true" || value.text === "false");
}

/** A numeric-literal seed for the `+=`-style accumulator (`x = 0; x = x +
 *  n`), distinguished from `isStringLit` so the multi-def accumulator role
 *  can pick `sum` over `s`. Deliberately excludes `NaN`/`Infinity`
 *  (identifiers, not `lit` text under this emitter) — see `emit/ast.ts`'s
 *  `renderNumber`. */
function isNumericLit(value: Expr): boolean {
  return value.k === "lit" && /^-?\d/.test(value.text);
}

/** §9 Q4 "iterated-over array/object … from property evidence" — a
 *  single-def register whose value is a non-computed member read
 *  (`a1.items`, `this.cache`) takes the property's own name. Never fires
 *  for a *computed* member (`a1[k]`) — the property there is a value, not a
 *  name — nor for a member that is itself a `call`'s callee (that is
 *  `callResultBase`'s territory: the def would be a `call` node, not a bare
 *  `member`, so there is no overlap). */
function propertyAliasBase(value: Expr): string | null {
  if (value.k !== "member") return null;
  if (!value.computed && value.prop.k === "lit") return value.prop.text;
  // A computed access is still a plain property alias, not container
  // evidence, when the key is a literal string (`a1["items"]` reads
  // identically to `a1.items` — bracket notation used for a reserved word
  // or a mangled name): strip the emitter's quotes and reuse the same base
  // as the dot-notation case, still subject to `resolveBase`'s `IDENT_RE`
  // check (an empty or non-identifier-shaped key is refused there, not
  // here — the property text is program-supplied, so it may legitimately
  // fail that check, e.g. `a1["a b"]`).
  if (value.computed && value.prop.k === "lit" && isStringLit(value.prop)) {
    const inner = value.prop.text.slice(1, -1);
    return inner.length > 0 ? inner : null;
  }
  return null;
}

/** §9 Q4 "alias-of-named-thing … that name with a suffix" — a single-def
 *  register that is a bare alias of another *already-meaningful* binding
 *  (an outer-scope var, `this`-derived name is out since `this` is its own
 *  node kind, a module global, or another register this same batched match
 *  already resolved a real name for — `taken`/`resolveBase` handle the
 *  suffix either way). Deliberately excludes register names (a fresher
 *  alias of an *unnamed* register would just borrow its `rN`/`rN_j`, which
 *  is not a name) and default parameter names (`a\d+`): aliasing a
 *  positional param with no independent evidence is exactly the case spec
 *  §4.2's "Params" carve-out keeps `aN` for — `resolveBase` would refuse a
 *  literal `aN` candidate via `EMITTER_NAME_CLASS_RE` anyway, but skipping
 *  it here keeps the refusal reason `no-heuristic` (honest: "no evidence"),
 *  not a confusing `emitter-name-class` bounce off a heuristic that never
 *  should have fired. */
function identAliasBase(value: Expr): string | null {
  if (value.k !== "ident") return null;
  if (isRegisterName(value.name) || /^a\d+$/.test(value.name)) return null;
  return value.name;
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
    // §9 Q4 — an object-literal or closure def is exactly as unambiguous as
    // the array-literal case right above it: the shape *is* the evidence,
    // no program text to misread.
    if (value.k === "object") return resolveBase("obj", taken);
    if (value.k === "func") return resolveBase("fn", taken);
    // §9 Q4 — a weaker container signal than an explicit `Array`/method
    // call: the register is only ever subscripted. Ranked below the strong
    // array evidence above, above call-result (a subscript site is rarer
    // than a call result, so it is the more specific — hence higher-value —
    // signal when both could apply, which in practice they never do: a
    // `call`'s def value can't simultaneously be an `indexReceiver`).
    if (f.indexReceiver) return resolveBase("list", taken);
    const callBase = callResultBase(value);
    if (callBase !== null) return resolveBase(callBase, taken);
    // §9 Q4 — property-read alias: `r = a1.items` takes `items`. Ranked
    // after call-result (a `call` node never also matches `propertyAliasBase`,
    // which only looks at bare `member` values, so this is ordering-by-
    // specificity, not a real conflict).
    const propBase = propertyAliasBase(value);
    if (propBase !== null) return resolveBase(propBase, taken);
    if (isBooleanish(value) && f.usedAsTest) return resolveBase("ok", taken);
    // §9 Q4 — a bare boolean literal used only as a test reads as a flag;
    // never fires for a literal that isn't also read as a test (§4.2 #6's
    // gate, reused here) so a stray `r = true` with no test use stays
    // `no-heuristic` rather than guessing.
    if (isBooleanLit(value) && f.usedAsTest) return resolveBase("flag", taken);
    // §9 Q4 — a bare numeric-literal def read as one side of an ordering
    // comparison anywhere in the frame: honest about the register's role
    // (a threshold) without guessing what it bounds. Never fires for a
    // literal with no comparison use — that stays `no-heuristic`.
    if (isNumericLit(value) && f.comparisonOperand) return resolveBase("limit", taken);
    // §9 Q4 — generic alias-of-named-thing, lowest priority: every stronger
    // shape above (array/call/property/boolean) already claimed its def
    // value, so by the time this runs `value` is either an `ident` naming
    // something real (an outer var, a module global, a name another
    // candidate in this same batch already resolved) or nothing this rung
    // can say anything honest about.
    const aliasBase = identAliasBase(value);
    if (aliasBase !== null) return resolveBase(aliasBase, taken);
    return { ok: false, reason: "no-heuristic" };
  }

  // Multi-def: only the two whole-frame roles §4.1 recognises are licensed —
  // every def must be one loop's induction init/update (#1), or every def a
  // `+`-chain reading the register itself / a string or numeric literal
  // seed (#5, widened §9 Q4: `x = 0; x = x + n` is exactly the "accumulator
  // pattern" the brief asks for, and was previously `reuse-conflict` — the
  // string-only `isStringLit` gate rejected the numeric seed's `every`).
  if (defs.every((v) => f.inductionDefs.has(v))) return resolveInductionBase(taken);
  if (defs.every((v) => isBinPlusSelf(v, name) || isStringLit(v) || isNumericLit(v)) && defs.some((v) => isBinPlusSelf(v, name))) {
    const base = defs.some((v) => isStringLit(v)) ? "s" : "sum";
    return resolveBase(base, taken);
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
    .map((name) => ({ name, facts: facts.get(name) ?? { defValues: [], inductionDefs: new Set<Expr>(), arrayReceiver: false, indexReceiver: false, usedAsTest: false, comparisonOperand: false, firstDef: Number.POSITIVE_INFINITY } }))
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
