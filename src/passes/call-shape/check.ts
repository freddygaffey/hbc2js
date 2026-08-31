// call-shape checker — docs/specs/passes/04-call-shape.md §6.
//
// Deviation from the spec's own §6 item 1 ("expressionOnlyCheck(before,
// after) — the effect sequences must be deep-equal"), recorded here and in
// docs/AGENT-LOG.md: `../ast.ts`'s `expressionOnlyCheck` compares
// `effectSequence(before)` to `effectSequence(after)` for byte-for-byte
// equality, but `effectSequence`'s `call`/`new` case visits the callee
// *before* pushing the node's own effect entry — so `Reflect.apply(F, T,
// […])`'s callee `Reflect.apply` (a `member`) itself contributes a
// `member-read` effect that a rewritten `F(a…)` (callee `F`, no `member`
// unless `F` itself is one) does not, and the trailing `{call, calleeShape,
// arity}` entry necessarily changes shape too (that is the whole point of
// the rewrite: it *is* a different call expression). The reverse happens for
// R3d: `F.call(T, …)`'s callee is now `member(F, "call")`, a property read
// `__hbc_b_functionPrototypeCall(F, T, …)`'s plain-`ident` callee never
// performed. A literal `expressionOnlyCheck` would therefore refuse every
// correct rewrite this rung makes, in both directions — it was written for a
// rung that only ever *moves* a value, never changes which expression node
// performs an already-distinct kind of read. What actually matters (D14: no
// reordering, no re-evaluation, no dropped effect *among the real
// arguments*) is checked directly below instead: the exact same site
// `match` would pick is re-derived from `before` alone (`classifyNode` never
// reads captured `match` data — this function does not even receive it),
// every statement but that one is asserted byte-identical, and the matched
// statement is asserted byte-identical to `applyReplacement(before[…],
// target, replacement)` — the same pure builder `rewrite.ts` uses. Since
// `replacement`'s args are exactly the source array's elements (or, for
// R3d, the helper call's own trailing args) reused by reference, never
// re-ordered or re-built, this is a stronger guarantee of "no observable
// difference among the real arguments" than a blind sequence diff would be
// for this rung's shape of rewrite.
import type { Expr, Stmt } from "../ast.ts";
import { effectSequence } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { classifyNode, collectCandidates } from "./match.ts";
import { applyReplacement } from "./rewrite.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b); // identity first: rewrite keeps every untouched statement (P-1)
}

interface FoundSite {
  readonly stmtIndex: number;
  readonly rule: string;
  readonly target: Expr;
  readonly replacement: Expr;
}

/** Recomputes, from `before` alone, the first candidate `match` would have
 *  picked (same enumeration, same classifier) — the "recompute; do not trust
 *  captured data" item §6 asks for, satisfied structurally: this function
 *  never receives `match`'s `Match.data` at all. */
function recomputeSite(before: readonly Stmt[], fnBody: readonly Stmt[]): { readonly found: FoundSite | null; readonly firstReason: string | null } {
  let firstReason: string | null = null;
  for (const c of collectCandidates(before)) {
    const v = classifyNode(c.node, fnBody);
    if (v.ok) return { found: { stmtIndex: c.stmtIndex, rule: v.rule, target: c.node, replacement: v.replacement }, firstReason };
    if (firstReason === null && v.reason !== "not-a-call-shape-site") firstReason = v.reason;
  }
  return { found: null, firstReason };
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  if (after.length !== before.length) {
    return { ok: false, reason: "unexpected shape: call-shape only ever rewrites one call node in place, never adds or removes a statement" };
  }

  const fnBody = ctx.fnBody ?? before;
  const { found, firstReason } = recomputeSite(before, fnBody);
  if (found === null) return { ok: false, reason: firstReason ?? "no recognised call-shape site in before" };

  for (let k = 0; k < before.length; k++) {
    if (k === found.stmtIndex) continue;
    if (!sameStmt(before[k]!, after[k]!)) return { ok: false, reason: "unexpected shape: a statement other than the matched site changed" };
  }

  if (found.replacement.k !== "call" && found.replacement.k !== "new") {
    return { ok: false, reason: "internal: replacement was neither call nor new" };
  }
  const expectedArgCount = found.replacement.args.length;

  // Item 2: the rewritten node's argument count equals the source array's
  // length (R3a/R3b/R3c only — R3d has no array literal to compare against,
  // per §4's own note that `.apply`'s `arr` "may be any expression").
  if (found.rule === "R3a" || found.rule === "R3b" || found.rule === "R3c") {
    const target = found.target as Expr & { readonly k: "call" };
    const arrIndex = found.rule === "R3c" ? 1 : 2;
    const arr = target.args[arrIndex];
    if (arr === undefined || arr.k !== "array" || arr.elements.length !== expectedArgCount) {
      return { ok: false, reason: "the rewritten node's argument count does not equal the source array's length" };
    }
  }

  // Items 3-6 (callee purity, R3a's `T`-is-undefined proof, R3b's `O`/`R`
  // identity, R3c's new-target check) are exactly what `classifyNode`
  // recomputed above from `before` alone to reach `found` at all — a
  // successful `recomputeSite` already re-proved every one of them.

  const expectedStmt = applyReplacement(before[found.stmtIndex]!, found.target, found.replacement);
  if (!sameStmt(expectedStmt, after[found.stmtIndex]!)) {
    return { ok: false, reason: "the rewrite did not exactly replace the matched call node" };
  }

  // R3b: the member read of `O.P` survives into `after` (§6 item 1's
  // explicit example) — guaranteed by construction (`replacement`'s callee
  // *is* `target`'s member callee, the same node reference), reconfirmed
  // here rather than only assumed.
  if (found.rule === "R3b") {
    const beforeReads = effectSequence([{ k: "expr", expr: found.target }]).filter((e) => e.k === "member-read").length;
    const afterReads = effectSequence([{ k: "expr", expr: found.replacement }]).filter((e) => e.k === "member-read").length;
    if (afterReads < 1 || afterReads > beforeReads) return { ok: false, reason: "R3b's member read of O.P was not preserved" };
  }

  // Deliberately no `expressionOnlyCheck`-style "no `rN` read before its own
  // first def in `after`" collateral scan here (both `expr-rebuild` and
  // `global-access` run one): that check is sound only for a rewrite that
  // can *move* a register's def within the list. `call-shape` never does —
  // every register name in `after` sits at exactly the statement index it
  // sat at in `before` (the structural equality above already proves this,
  // since only the one matched call node's own shape changed). A register
  // legitimately read earlier in the list, then reassigned later — entirely
  // unrelated to this rewrite — was being flagged as "read before its first
  // def" by a first version of this check, because `defUse` has no way to
  // distinguish "the rewrite introduced this read" versus "this list's own,
  // pre-existing dataflow reads the register's *old* value before its next,
  // later, equally pre-existing def" (`33-class-inheritance-super` v99: a
  // plain, always-valid two-argument `Reflect.construct(r7, [r12, r11])`
  // with nothing wrong with it was abandoned this way, purely because `r13 =
  // r4;` reads `r4`'s old value earlier in the same list than a *later*,
  // unrelated `r4 = …` redefines it — found live via this fixture's own
  // `--emit-ast` diagnostics while landing this rung, not by any unit test).
  return { ok: true };
}
