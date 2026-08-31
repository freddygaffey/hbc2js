// fn-naming matcher — docs/LOWERING-CATALOGUE.md row R4,
// docs/specs/passes/05-fn-naming.md §4.
//
// Site = the function-body root list only (`match` returns `null` unless
// `list === ctx.fnBody`): `_fnN` is declared by a `func` statement in that
// list and its scope is the whole body, so a per-sublist site could not see
// every use. `classifyAll` computes every `_fnN` candidate's verdict in one
// pass (condition 6 — "no other `_fnM` in this list would claim the same
// `raw`" — is inherently cross-candidate) and is exported so `check.ts` can
// re-derive the same verdict from `before` alone, and so unit tests can
// assert the exact refuse reason without going through the driver — the same
// split `global-access/match.ts` uses.
//
// One match carries **every** qualifying rename in the list (§4 "batched"),
// not just the first: the verdicts are independent of one another (a
// rename only ever adds a `to` that no other candidate could have claimed —
// two candidates wanting the same `raw` are both `duplicate-name`), so
// renaming them one per driver iteration produced exactly the same output at
// O(K²·B) cost — K candidates re-classified, each with a whole-body walk,
// after every one of K splices. On a real bundle's global function (K≈440
// module factories over a 6 MB body) that was hours, and the reason the M5
// pipeline was ~250x slower than the baseline (docs/PUSHBACK.md P-1). The
// batched match is O(B): the body-wide sets are computed once per
// classification, the per-name read counts in one walk (`identUsesMany`).
import type { Stmt } from "../ast.ts";
import { freeNames, identUsesMany, isSafeIdentifier, walk } from "../ast.ts";
import type { ModuleView } from "../tree.ts";
import type { Match, PassContext } from "../types.ts";

/** One `_fnN` → `to` rename. */
export interface FnNamingRename {
  /** Index of the `func` statement in the site's own list. */
  readonly stmtIndex: number;
  /** Function-table index `N` (`fnName(N) === from`). */
  readonly n: number;
  readonly from: string;
  readonly to: string;
}

/** The site's data: every qualifying rename in the root list, in statement
 *  order (never empty — `match` returns `null` instead). */
export interface FnNamingSite {
  readonly renames: readonly FnNamingRename[];
}

export type FnNamingMatch = Match<readonly Stmt[], FnNamingSite>;

export type RefuseReason =
  | "global-function"
  | "anonymous"
  | "unsafe-identifier"
  | "reserved-word"
  | "emitter-name-class"
  | "captures-free-name"
  | "already-declared"
  | "duplicate-name"
  | "ambiguous-name";

export type ClassifyResult = { readonly ok: true; readonly site: FnNamingRename } | { readonly ok: false; readonly reason: RefuseReason };

const FN_RE = /^_fn(\d+)$/;

// §4 condition 3 — the emitter-generated name classes a recovered name must
// never be able to collide with (copied, not imported — D12a; the same
// convention `global-access/match.ts`'s `looksSynthetic` and
// `src/emit/names.ts` itself already follow).
const EMITTER_NAME_CLASS_RE = /^(_fn\d+|_e\d+_\d+|r\d+|__.*|_exc\d+|L\d+|__state\d+)$/;

// The syntactic half of `isSafeIdentifier` (`src/passes/ast.ts`), copied so
// this rung can tell "not a valid identifier at all" (`unsafe-identifier`)
// apart from a reserved word that is otherwise perfectly valid syntax
// (`reserved-word`) — `isSafeIdentifier` alone only reports the conjunction.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ---------------------------------------------------------------------------
// §4 condition 5 — names already declared anywhere in the function.
// ---------------------------------------------------------------------------

/** Names bound anywhere reachable from `stmts` — `decl`/`init` names, a
 *  `func`'s own name and parameters (root-level or nested), and a `catch`
 *  binding. Mirrors `global-access/match.ts`'s private `declaredNames`
 *  (copied, not shared — each rung owns its own little helpers, D12a). */
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
// §4 R4b — name from the one qualifying assignment site, when `functionName`
// is empty.
// ---------------------------------------------------------------------------

/** `{from, key}` of a root-level statement of the shape `X.key = ident(from)`
 *  (a `member` write, `computed:false`) or `{k:"init", name:key, value:
 *  ident(from)}` — `null` for anything else. Root-level statements only
 *  (§4 R4b: "the root list contains exactly one statement of the form…"),
 *  never recursing into a nested list. */
function assignmentKey(s: Stmt): { readonly from: string; readonly key: string } | null {
  if (s.k === "init" && s.value.k === "ident") return { from: s.value.name, key: s.name };
  if (s.k === "expr" && s.expr.k === "assign") {
    const { target, value } = s.expr;
    if (target.k === "member" && !target.computed && target.prop.k === "lit" && value.k === "ident") {
      return { from: value.name, key: target.prop.text };
    }
  }
  return null;
}

/** The body-wide facts every candidate's verdict is read against, each
 *  computed at most once per classification and only when some candidate
 *  gets far enough to need it (a body whose candidates are all refused by
 *  name alone never pays for a walk). This is the whole of the P-1 fix on
 *  the matcher side: before, every one of these was recomputed per
 *  candidate, per driver iteration. */
class BodyFacts {
  #free: Set<string> | undefined;
  #declared: Set<string> | undefined;
  #reads: Map<string, number> | undefined;
  #keys: Map<string, string[]> | undefined;
  readonly #list: readonly Stmt[];
  readonly #fnBody: readonly Stmt[];
  readonly #anonymous: readonly string[];
  constructor(list: readonly Stmt[], fnBody: readonly Stmt[], anonymous: readonly string[]) {
    this.#list = list;
    this.#fnBody = fnBody;
    this.#anonymous = anonymous;
  }
  free(): Set<string> {
    return (this.#free ??= freeNames(this.#fnBody));
  }
  declared(): Set<string> {
    return (this.#declared ??= declaredNames(this.#fnBody));
  }
  /** `identUses(fnBody, from).reads` for every anonymous candidate, one walk. */
  reads(from: string): number {
    if (this.#reads === undefined) {
      this.#reads = new Map();
      for (const [name, u] of identUsesMany(this.#fnBody, this.#anonymous)) this.#reads.set(name, u.reads);
    }
    return this.#reads.get(from) ?? 0;
  }
  /** R4b's root-level assignment keys, grouped by the `_fnN` they assign. */
  keys(from: string): readonly string[] {
    if (this.#keys === undefined) {
      this.#keys = new Map();
      for (const s of this.#list) {
        const a = assignmentKey(s);
        if (a === null || !FN_RE.test(a.from)) continue;
        const bucket = this.#keys.get(a.from);
        if (bucket === undefined) this.#keys.set(a.from, [a.key]);
        else bucket.push(a.key);
      }
    }
    return this.#keys.get(from) ?? [];
  }
}

/** §4 condition 2 + R4b: the evidence name for function-table index `n`, or
 *  the specific refusal when none qualifies. `functionName` wins outright
 *  when non-empty; R4b's assignment-site fallback only ever runs when it is
 *  empty. */
function evidenceName(facts: BodyFacts, module: ModuleView, n: number): { readonly raw: string } | { readonly reason: "anonymous" | "ambiguous-name" } {
  const declared = module.functionName(n);
  if (declared !== "") return { raw: declared };
  const from = `_fn${n}`;
  const keys = facts.keys(from);
  if (keys.length > 1) return { reason: "ambiguous-name" };
  if (keys.length === 0) return { reason: "anonymous" };
  // Exactly one candidate site: it must also be `from`'s *only* read in the
  // whole function, or the evidence is not trustworthy (some other read
  // could be the "real" use `from` was captured for).
  if (facts.reads(from) !== 1) return { reason: "anonymous" };
  return { raw: keys[0]! };
}

/** §4 conditions 2 (minus condition 6, which is cross-candidate) for one
 *  `_fnN` candidate. */
function classifyOne(facts: BodyFacts, module: ModuleView, n: number): { readonly raw: string | null; readonly reason: RefuseReason | null } {
  if (module.isGlobalFunction(n)) return { raw: null, reason: "global-function" };
  const evidence = evidenceName(facts, module, n);
  if ("reason" in evidence) return { raw: null, reason: evidence.reason };
  const raw = evidence.raw;
  if (!IDENT_RE.test(raw)) return { raw: null, reason: "unsafe-identifier" };
  if (!isSafeIdentifier(raw)) return { raw: null, reason: "reserved-word" };
  if (EMITTER_NAME_CLASS_RE.test(raw)) return { raw: null, reason: "emitter-name-class" };
  if (facts.free().has(raw)) return { raw: null, reason: "captures-free-name" };
  if (facts.declared().has(raw)) return { raw: null, reason: "already-declared" };
  return { raw, reason: null };
}

interface CandidateResult {
  readonly stmtIndex: number;
  readonly n: number;
  readonly result: ClassifyResult;
}

/** Every `_fnN`-named `func` statement directly in `list`, classified —
 *  condition 6 (duplicate `raw` across candidates) applied last, since it can
 *  only be decided once every other candidate's verdict is known. */
function classifyAll(list: readonly Stmt[], fnBody: readonly Stmt[], module: ModuleView): readonly CandidateResult[] {
  const candidates: { stmtIndex: number; n: number }[] = [];
  list.forEach((s, stmtIndex) => {
    if (s.k !== "func") return;
    const m = FN_RE.exec(s.name);
    if (m !== null) candidates.push({ stmtIndex, n: Number(m[1]) });
  });
  const anonymous = candidates.filter((c) => !module.isGlobalFunction(c.n) && module.functionName(c.n) === "").map((c) => `_fn${c.n}`);
  const facts = new BodyFacts(list, fnBody, anonymous);
  const raw = candidates.map((c) => {
    const r = classifyOne(facts, module, c.n);
    return { stmtIndex: c.stmtIndex, n: c.n, raw: r.raw, reason: r.reason };
  });
  const counts = new Map<string, number>();
  for (const c of raw) {
    if (c.reason === null && c.raw !== null) counts.set(c.raw, (counts.get(c.raw) ?? 0) + 1);
  }
  return raw.map((c): CandidateResult => {
    if (c.reason === null && c.raw !== null && (counts.get(c.raw) ?? 0) > 1) {
      return { stmtIndex: c.stmtIndex, n: c.n, result: { ok: false, reason: "duplicate-name" } };
    }
    if (c.reason !== null) return { stmtIndex: c.stmtIndex, n: c.n, result: { ok: false, reason: c.reason } };
    return { stmtIndex: c.stmtIndex, n: c.n, result: { ok: true, site: { stmtIndex: c.stmtIndex, n: c.n, from: `_fn${c.n}`, to: c.raw! } } };
  });
}

/** Re-derives the full §4 verdict for the `_fnN` candidate at `list[stmtIndex]`
 *  — the same classification `match` uses internally, exported so `check.ts`
 *  can recompute it from `before` alone and so unit tests can assert an exact
 *  refuse reason without going through the driver. */
export function classifySite(list: readonly Stmt[], fnBody: readonly Stmt[], module: ModuleView, stmtIndex: number): ClassifyResult {
  const found = classifyAll(list, fnBody, module).find((c) => c.stmtIndex === stmtIndex);
  return found?.result ?? { ok: false, reason: "anonymous" };
}

export function match(list: readonly Stmt[], ctx: PassContext): FnNamingMatch | null {
  if (list !== ctx.fnBody || ctx.module === undefined) return null;
  const renames: FnNamingRename[] = [];
  for (const c of classifyAll(list, ctx.fnBody, ctx.module)) if (c.result.ok) renames.push(c.result.site);
  if (renames.length === 0) return null;
  return { root: list, nodes: [list], data: { renames }, at: { functionIndex: ctx.functionIndex, offset: renames[0]!.stmtIndex } };
}

export { EMITTER_NAME_CLASS_RE, FN_RE, IDENT_RE };
