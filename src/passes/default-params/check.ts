// default-params checker — docs/specs/passes/15-default-params.md §6,
// re-derived for the labeled-block idiom (P-8). Nothing here trusts the
// match `data` the driver captured earlier (README): every item below is
// recomputed from `before` alone, the same discipline
// `expr-rebuild/check.ts`, `for-header/check.ts` and `loop-cond/check.ts`
// use.
import type { Expr, Stmt } from "../ast.ts";
import { effectSequence, freeNames } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import type { FuncLike } from "./match.ts";
import { buildFunc, classifyFunc, extractFunc } from "./match.ts";

function sameExpr(a: Expr, b: Expr): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameStmts(a: readonly Stmt[], b: readonly Stmt[]): boolean {
  return a.length === b.length && a.every((s, i) => sameStmt(s, b[i]!));
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  void ctx;
  if (before.length !== after.length) return { ok: false, reason: "default-params changed the enclosing list's length" };

  let idx = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      if (idx !== -1) return { ok: false, reason: "default-params touched more than one statement" };
      idx = i;
    }
  }
  if (idx === -1) return { ok: false, reason: "default-params changed nothing" };

  const F0 = extractFunc(before[idx]!);
  const F1 = extractFunc(after[idx]!);
  if (F0 === null || F1 === null) return { ok: false, reason: "the changed statement does not carry a func node on both sides" };

  // Recompute the defaults from `before` alone — never trust the driver's
  // captured match data.
  const { defaults, consumed } = classifyFunc(F0);
  if (defaults.length === 0) return { ok: false, reason: "no-defaults" };

  // §6 item 3: `after`'s params are `before`'s with exactly the accepted
  // records appended, in ascending `k`, contiguous from `before.params.length`.
  if (F1.params.length !== F0.params.length + defaults.length) return { ok: false, reason: "unexpected param-list length" };
  for (let i = 0; i < F0.params.length; i++) {
    if (!sameParam(F0.params[i]!, F1.params[i]!)) return { ok: false, reason: "default-params disturbed an existing parameter" };
  }
  for (let i = 0; i < defaults.length; i++) {
    const p = F1.params[F0.params.length + i]!;
    const d = defaults[i]!;
    if (p.name !== d.rX || p.rest === true || p.init === undefined || !sameExpr(p.init, d.init)) return { ok: false, reason: "unlowerable-default" };
    // D14 / §6's "prove the guard polarity": the default this rung installs
    // must be exactly the value the guarded block assigns when — and only
    // when — `arguments[k]` is strictly `undefined` (`classifyFunc`'s own
    // `matchGuard` already required `op === "!=="` on the register that was
    // loaded from `arguments[k]`, re-checked here so a mutation to that
    // operator, silently accepted elsewhere, cannot pass this checker).
    const guard = (F0.body[d.labelIndex] as Extract<Stmt, { k: "labeled" }>).body.find((s) => s.k === "if" && s.test.k === "bin" && s.test.left.k === "ident" && s.test.left.name === d.rX);
    if (guard === undefined || guard.k !== "if" || guard.test.k !== "bin" || guard.test.op !== "!==") return { ok: false, reason: "not-undefined-guard" };
  }

  // §6 item: recompute the exact expected function the same way `rewrite.ts`
  // did (a pure function of `(F0, defaults)`, both re-derived from `before`
  // alone above) and require a byte-for-byte structural match — the same
  // "reproduced by calling the very same builder" discipline
  // `expr-rebuild/check.ts` uses for its own writer reuse.
  const expected: FuncLike = buildFunc(F0, defaults, consumed);
  if (!sameParamList(expected.params, F1.params) || !sameStmts(expected.body, F1.body)) {
    return { ok: false, reason: "the rewrite did not produce the expected function" };
  }

  // §6 item 1, honest version, per default: the observable effect sequence
  // of the *raw* (pre-substitution) guarded body this default came from
  // must equal the effect sequence of the single `init` expression that
  // replaced it — proof that folding the guard into a parameter default
  // dropped no effect and reordered nothing. Independent of `buildFunc`
  // above: `rawBody` is re-derived here directly from `F0`'s own labeled
  // block and `consumed` (which statements the guard/break are — not what
  // `init` should *contain*), never from `d.init` or from calling the
  // writer again, so a mutated writer producing a wrong-but-plausible
  // `init` cannot hide behind this check reusing its own mistake.
  for (const d of defaults) {
    const block = F0.body[d.labelIndex] as Extract<Stmt, { k: "labeled" }>;
    const guardIdx = block.body.findIndex((st) => consumed.has(st) && st.k === "if");
    if (guardIdx < 0) return { ok: false, reason: "not-undefined-guard" };
    const rawBody = block.body.slice(guardIdx + 1, -1);
    // `effectSequence` treats every `k:"func"` body as opaque (a function
    // *definition* has no effect of its own — §3's F15 note) — sound for a
    // bare `seq`, but `collapseToIife`'s IIFE shape is a `call` whose
    // callee happens to be one of those opaque bodies, immediately invoked,
    // so its effects run right here and must be un-opaqued for this proof:
    // reconstruct the statement list it collapsed from (`return E` back to
    // `rX = E`, dropping the synthetic `let`) and compare that instead of
    // the wrapped call.
    const forEffects: readonly Stmt[] =
      d.init.k === "call" && d.init.callee.k === "func"
        ? d.init.callee.body.flatMap((s): readonly Stmt[] => (s.k === "decl" ? [] : s.k === "return" && s.arg !== null ? [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: d.rX }, value: s.arg } }] : [s]))
        : [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: d.rX }, value: d.init } }];
    const initEffects = JSON.stringify(effectSequence(forEffects));
    const rawEffects = JSON.stringify(effectSequence(rawBody));
    if (initEffects !== rawEffects) return { ok: false, reason: "default-params changed the observable effect sequence" };
  }

  // §6 item 4: no accepted `rX` survives in a `decl`, and none is free in
  // the *enclosing* list (would shadow something already meaningful there).
  const outerFree = freeNames(after.filter((_, i) => i !== idx));
  for (const d of defaults) {
    if (outerFree.has(d.rX)) return { ok: false, reason: "default-params shadowed a name free in the enclosing scope" };
    if (F1.body.some((s) => s.k === "decl" && s.names.includes(d.rX))) return { ok: false, reason: "a moved parameter is still declared with let" };
  }

  // §6 item 6 / F15's printer backstop: deliberately NOT `parses(after)` per
  // site. The stage-B driver already runs `parses` once per (pass, function)
  // on the whole reconstructed body (`src/passes/README.md`); doing it here
  // too both costs a whole-list print+parse on every site of a real bundle
  // and spuriously refuses one whose enclosing list holds an untouched bare
  // `break`/`continue` (legal in the real function, illegal the moment this
  // list alone is wrapped standalone — object-literal/check.ts, commit
  // 3b0ec3a, docs/BUGS.md `stage-b-per-site-parses`).

  return { ok: true };
}

function sameParam(a: { readonly name: string; readonly init?: Expr; readonly rest?: true }, b: { readonly name: string; readonly init?: Expr; readonly rest?: true }): boolean {
  if (a.name !== b.name || a.rest !== b.rest) return false;
  if ((a.init === undefined) !== (b.init === undefined)) return false;
  return a.init === undefined || sameExpr(a.init, b.init!);
}

function sameParamList(a: readonly { readonly name: string; readonly init?: Expr; readonly rest?: true }[], b: readonly { readonly name: string; readonly init?: Expr; readonly rest?: true }[]): boolean {
  return a.length === b.length && a.every((p, i) => sameParam(p, b[i]!));
}
