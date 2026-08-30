// global-access checker — docs/specs/passes/03-global-access.md §6.
//
// `check(before, after, ctx)` gets no access to `match`'s captured `data`, so
// every item below is *recomputed* from `before`/`after` alone. `rewrite`
// only ever touches two indices (deletes `guardIndex`, replaces the shifted
// `useIndex`), so the changed positions are found the same way
// `expr-rebuild/check.ts` finds its one changed index — a common-prefix scan
// — applied twice (once for the deletion, once for the shifted rewrite).
import type { Effect, Expr, Stmt } from "../ast.ts";
import { defUse, effectSequence, isSafeIdentifier } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { isProvenGlobal, isShadowed, isTargetRead, recognizeGuard } from "./match.ts";
import { substitute } from "./rewrite.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameEffect(a: Effect, b: Effect): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** First index where `a`/`b` diverge, scanning their common prefix. */
function firstDivergence<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && same(a[i]!, b[i]!)) i++;
  return i;
}

/** Occurrences of the target read within `exprs` — mirrors
 *  `match.ts`'s private `countMatchingReads`, needed again here to verify
 *  item 2 independently of `classifySite`'s own scan (which only tests
 *  *later* statements, not the exact one `before`/`after` says changed). */
function countReads(e: Expr, global: Expr, name: string): number {
  if (isTargetRead(e, global, name)) return 1;
  switch (e.k) {
    case "member":
      return countReads(e.obj, global, name) + (e.computed ? countReads(e.prop, global, name) : 0);
    case "call":
    case "new":
      return countReads(e.callee, global, name) + e.args.reduce((n, a) => n + countReads(a, global, name), 0);
    case "bin":
    case "logical":
      return countReads(e.left, global, name) + countReads(e.right, global, name);
    case "unary":
      return countReads(e.arg, global, name);
    case "assign":
      return countReads(e.target, global, name) + countReads(e.value, global, name);
    case "cond":
      return countReads(e.test, global, name) + countReads(e.then, global, name) + countReads(e.else, global, name);
    case "array":
      return e.elements.reduce((n, x) => n + countReads(x, global, name), 0);
    case "object":
      return e.props.reduce((n, p) => n + countReads(p.value, global, name), 0);
    case "seq":
      return e.exprs.reduce((n, x) => n + countReads(x, global, name), 0);
    default:
      return 0; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

function topLevelExprFields(s: Stmt): readonly Expr[] {
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
      return [];
  }
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  if (after.length !== before.length - 1) {
    return { ok: false, reason: "unexpected shape: global-access only ever deletes the guard and rewrites one statement" };
  }

  // Item 1: recover the guard and re-verify its shape.
  const guardIndex = firstDivergence(before, after, sameStmt);
  const guardStmt = before[guardIndex];
  if (guardStmt === undefined) return { ok: false, reason: "no-read-after-guard" };
  const shape = recognizeGuard(guardStmt);
  if (shape === null) return { ok: false, reason: "not a recognised global-access guard" };
  const { name, global } = shape;

  // Item 2: locate the rewritten use (before[useIndex] / after[useIndex-1])
  // by diffing the tails once the guard's own removal is accounted for.
  const useOffset = firstDivergence(before.slice(guardIndex + 1), after.slice(guardIndex), sameStmt);
  const useIndex = guardIndex + 1 + useOffset;
  const useStmt = before[useIndex];
  if (useStmt === undefined) return { ok: false, reason: "no-read-after-guard" };
  const topReads = topLevelExprFields(useStmt).reduce((n, e) => n + countReads(e, global, name), 0);
  if (topReads > 1) return { ok: false, reason: "read-twice" };
  if (topReads !== 1) return { ok: false, reason: "no-read-after-guard" };

  const rewrittenStmt = after[useIndex - 1];
  if (rewrittenStmt === undefined || !sameStmt(rewrittenStmt, substitute(useStmt, global, name))) {
    return { ok: false, reason: "the rewrite did not exactly substitute the matched read" };
  }
  // Tail beyond the rewritten statement must be untouched.
  for (let k = useIndex + 1; k < before.length; k++) {
    if (!sameStmt(before[k]!, after[k - 1]!)) return { ok: false, reason: "unexpected shape: a statement beyond the rewritten use changed" };
  }

  // Item 4: `G` is still a proven global reference in `before`.
  const fnBody = ctx.fnBody ?? before;
  if (!isProvenGlobal(fnBody, global)) return { ok: false, reason: "unproven-global" };

  // Item 5: `p` is not a declared name in `before`.
  if (!isSafeIdentifier(name)) return { ok: false, reason: "unsafe-identifier" };
  if (isShadowed(name, fnBody)) return { ok: false, reason: "shadowed" };

  // Item 3: the one effect pair the rung is licensed to change — the guard's
  // `in` test + its unreached `throw new ReferenceError(...)`, and the one
  // `G.p` member-read — disappear together; nothing else about the ordered
  // effect sequence moves. `withoutGuard` already removes the guard's own
  // contiguous effect contribution (a whole statement deleted outright), so
  // it needs no separate subtraction from `effectSequence(before)`; the only
  // remaining difference `afterEff` may show is the loss of exactly one
  // `member-read` (the target read is now a bare identifier, which
  // contributes no effect at all).
  const withoutGuard = [...before.slice(0, guardIndex), ...before.slice(guardIndex + 1)];
  const midEff = effectSequence(withoutGuard);
  const afterEff = effectSequence(after);
  if (midEff.length !== afterEff.length + 1) {
    return { ok: false, reason: "the rewrite changed the observable effect sequence" };
  }
  const divergeAt = firstDivergence(midEff, afterEff, sameEffect);
  if (divergeAt >= midEff.length || midEff[divergeAt]!.k !== "member-read") {
    return { ok: false, reason: "the rewrite changed the observable effect sequence" };
  }
  for (let k = divergeAt; k < afterEff.length; k++) {
    if (!sameEffect(midEff[k + 1]!, afterEff[k]!)) return { ok: false, reason: "the rewrite changed the observable effect sequence" };
  }

  // No `rN` in `after` is read before its own first def (mirrors
  // `expressionOnlyCheck`'s second half) — a bare identifier introduces no
  // new register, so this only guards against an unrelated regression.
  for (const [regName, { defs, reads }] of defUse(after)) {
    if (defs.length === 0) continue;
    const firstDef = Math.min(...defs);
    if (reads.some((r) => r < firstDef)) return { ok: false, reason: `${regName} is read before its first def in the rewrite` };
  }

  return { ok: true };
}
