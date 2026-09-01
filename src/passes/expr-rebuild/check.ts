// expr-rebuild checker — docs/specs/passes/02-expr-rebuild.md §6.
//
// `check(before, after, ctx)` gets no access to `match`'s captured `data`
// (that is the `Pass` contract), so every item below is *recomputed* from
// `before`/`after` alone, never trusted from the earlier call — exactly what
// §6 item 1 asks for ("recompute; do not trust captured data"). The single
// changed index is found by diffing `before`/`after` (rewrite only ever
// touches index `i`, and for R1a also index `j`), then `classifySite` (the
// same function `match` used) is re-run at that `i` to re-derive the rule
// and re-prove deadness/legality/nesting — items 1, 2, 3 and 5 all fold into
// that one re-derivation; item 4 (the exact read/write delta) is checked
// independently below since it is about `after`, which classification never
// sees.
import type { Expr, Stmt } from "../ast.ts";
import { expressionOnlyCheck, isPure, isRegisterName, registerUses } from "../ast.ts";

const NO_USES = { reads: 0, writes: 0, nested: 0 } as const;
import type { CheckResult, PassContext } from "../types.ts";
import { classifySite, exprCounts } from "./match.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b); // identity first: rewrite keeps every untouched statement (P-1)
}

/** First index where `before`/`after` diverge, scanning the common prefix —
 *  by construction (rewrite touches only `i`, and for R1a also `j > i`) this
 *  is always the store's own index. */
function firstDivergence(before: readonly Stmt[], after: readonly Stmt[]): number {
  const n = Math.min(before.length, after.length);
  let i = 0;
  while (i < n && sameStmt(before[i]!, after[i]!)) i++;
  return i;
}

/**
 * `registerUses(after).get(reg)`, without ever walking `after` in full.
 * `registerUses` (`../ast.ts`) is a plain left-to-right accumulation over
 * `stmts` with no cross-statement state, so it is concatenative:
 * `registerUses(A ++ B ++ C) = registerUses(A) + registerUses(B) +
 * registerUses(C)` (componentwise). This rewrite only ever touches a
 * bounded region — one store, replaced or removed, plus at most one other
 * statement it folds into — so `before`/`after` share a reference-identical
 * prefix and suffix; `bu` (already computed, and a cache hit whenever
 * `before` is `ctx.fnBody` itself — the common case, and the one a real
 * bundle's module-root function makes matter) covers the whole of
 * `before`, so subtracting the small unchanged-middle's `before` count and
 * adding the small unchanged-middle's `after` count gives exactly
 * `registerUses(after).get(reg)`, for `O(changed region)` instead of
 * `O(list.length)` per applied site (`docs/BUGS.md`'s superlinear-pass
 * row: this and the module-level `listIndex` rebuild `match.ts` no longer
 * does were the two hottest frames profiled against a real bundle's
 * module-root function).
 */
function registerUsesAfter(before: readonly Stmt[], after: readonly Stmt[], reg: string, bu: { readonly reads: number; readonly writes: number; readonly nested: number }): { readonly reads: number; readonly writes: number; readonly nested: number } {
  const minLen = Math.min(before.length, after.length);
  let head = 0;
  while (head < minLen && before[head] === after[head]) head++;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }
  const beforeMid = registerUses(before.slice(head, tailBefore)).get(reg) ?? NO_USES;
  const afterMid = registerUses(after.slice(head, tailAfter)).get(reg) ?? NO_USES;
  return {
    reads: bu.reads - beforeMid.reads + afterMid.reads,
    writes: bu.writes - beforeMid.writes + afterMid.writes,
    nested: bu.nested - beforeMid.nested + afterMid.nested,
  };
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const eff = expressionOnlyCheck(before, after);
  if (!eff.ok) return eff;

  if (after.length !== before.length && after.length !== before.length - 1) {
    return { ok: false, reason: "unexpected shape: expr-rebuild only ever deletes or replaces exactly one statement" };
  }

  const i = firstDivergence(before, after);
  const store = before[i];
  if (store === undefined || store.k !== "expr" || store.expr.k !== "assign" || store.expr.target.k !== "ident") {
    return { ok: false, reason: "not-dead" }; // nothing recognisable as our own rewrite changed here
  }
  const reg = store.expr.target.name;
  if (!isRegisterName(reg)) return { ok: false, reason: "protocol-name" };

  const info = ctx.cfg?.generator?.info;
  if (info !== undefined && info.era === "opcode" && info.kind !== "normal") return { ok: false, reason: "generator-frame" };

  const value: Expr = store.expr.value;
  const fnBody = ctx.fnBody ?? before;
  const verdict = classifySite(before, fnBody, i, reg, value);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  // Item 4: the exact read/write delta. Writes always drop by one (the store
  // itself). Reads drop by one for R1a (the folded read is now gone — E's own
  // reads of `reg`, if any, simply relocate from `i` to `j`, netting zero);
  // for R1b/R1c reads drop only by however many times `E` itself read `reg`
  // and got *deleted* (pure) — an impure R1b keeps `E` (and its reads) alive.
  const eSelfReads = exprCounts(value, reg).reads;
  const expectedReadDelta = verdict.rule === "R1a" ? 1 : isPure(value) ? eSelfReads : 0;
  const bu = registerUses(before).get(reg) ?? NO_USES;
  const au = registerUsesAfter(before, after, reg, bu);
  if (bu.writes - au.writes !== 1) return { ok: false, reason: `rewrite did not remove exactly one write of ${reg}` };
  if (bu.reads - au.reads !== expectedReadDelta) return { ok: false, reason: `rewrite did not remove the expected read of ${reg}` };

  return { ok: true };
}
