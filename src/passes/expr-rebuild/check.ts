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
import type { IdentUses } from "../ast.ts";
import { expressionOnlyCheck, isPure, isRegisterName, noteRegisterUsesSplice, registerUses } from "../ast.ts";

const NO_USES = { reads: 0, writes: 0, nested: 0 } as const;
import type { CheckResult, PassContext } from "../types.ts";
import type { ExprRebuildSite } from "./match.ts";
import { classifySite, exprCounts } from "./match.ts";
import { impureStoreRemnant, substituteTopLevel } from "./rewrite.ts";

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
 * `registerUses(before).get(reg)` minus `registerUses(after).get(reg)`,
 * computed from the touched window alone. `registerUses` (`../ast.ts`) is a
 * plain left-to-right accumulation over `stmts` with no cross-statement
 * state, so it is concatenative: `registerUses(A ++ B ++ C) =
 * registerUses(A) + registerUses(B) + registerUses(C)` (componentwise).
 * `verifyExpectedShape` above has already proven, element by element over
 * the whole list, that `after` is exactly `before` with the region
 * `[lo, hiBefore)` replaced by `[lo, hiAfter)` and *nothing else changed*,
 * so writing `before = pre ++ beforeMid ++ post` and `after = pre ++
 * afterMid ++ post` for that same `pre`/`post`, the `registerUses(pre)` and
 * `registerUses(post)` terms cancel out of the subtraction exactly, leaving
 * `registerUses(beforeMid) - registerUses(afterMid)`.
 *
 * The window is derived from the re-classified site (`i`, and `j` for R1a),
 * so it is `O(j - i)` - the fold distance, short by construction, since
 * `match` only folds a read that is reachable without crossing an effect it
 * cannot commute with. Earlier revisions found the same window by scanning
 * in from both ends of the list for the reference-identical prefix/suffix,
 * which is `O(list.length)` per applied site; that whole-list walk (once per
 * applied site, since `spliceList` gives an edited list a fresh array
 * identity, so `registerUsesMemo` in `../ast.ts` is cold for it every time)
 * was a term in the 946 s Service NSW profile - `docs/BUGS.md`'s
 * superlinear-pass row, parts 2 and 4.
 */
function registerUseDelta(beforeMid: ReadonlyMap<string, IdentUses>, afterMid: ReadonlyMap<string, IdentUses>, reg: string): { readonly reads: number; readonly writes: number } {
  const b = beforeMid.get(reg) ?? NO_USES;
  const a = afterMid.get(reg) ?? NO_USES;
  return { reads: b.reads - a.reads, writes: b.writes - a.writes };
}

/**
 * Item: the exact substituted *value*, re-derived and compared a window at a
 * time. Classification and the read/write count delta both prove the rewrite
 * has the right *shape* (which rule, which statement dropped, how many reads
 * and writes moved) but neither looks at what got folded in - a mutated
 * writer that substitutes a wrong constant (or any other same-arity
 * expression) at the read site passes both unchanged (docs/BUGS.md,
 * 2026-09-01 checker-mutation row).
 *
 * This re-derives what `rewrite.ts` would build from the re-classified site
 * (`rule`, `i`, `j`, `reg`, `value`, all already re-proven from `before`
 * alone, never trusted from the writer's own call) and compares it against
 * the actual `after` position by position - the same guarantee the earlier
 * `expected = rewrite(...); expected.every(sameStmt)` form gave, since
 * `rewrite` is a pure function of `(root, data)` and the mapping below is
 * exactly its definition. The difference is cost: the earlier form rebuilt
 * the whole immutable statement array a second time per applied site (three
 * more array allocations and ~2x `list.length` element copies) to produce a
 * list whose every element outside the touched window is already
 * reference-identical to `after`'s. Here nothing is allocated at all: the
 * expected element at each position is `before`'s own object, except at the
 * one or two positions the rule actually rewrites, so the comparison is a
 * pointer test per position plus at most one structural comparison, and it
 * still covers every position (a writer that also perturbed some far-away
 * statement is still caught). `docs/BUGS.md`'s superlinear-pass row, part 4.
 */
function verifyExpectedShape(before: readonly Stmt[], after: readonly Stmt[], rule: ExprRebuildSite["rule"], i: number, j: number, reg: string, value: Expr): boolean {
  const impureStore = rule === "R1b" && !isPure(value);
  const expectedLength = impureStore ? before.length : before.length - 1;
  if (after.length !== expectedLength) return false;
  for (let k = 0; k < i; k++) {
    if (!sameStmt(before[k]!, after[k]!)) return false;
  }
  if (impureStore) {
    if (!sameStmt(impureStoreRemnant(value), after[i]!)) return false;
    for (let k = i + 1; k < after.length; k++) {
      if (!sameStmt(before[k]!, after[k]!)) return false;
    }
    return true;
  }
  const newJ = rule === "R1a" ? j - 1 : -1;
  for (let k = i; k < after.length; k++) {
    const expected = k === newJ ? substituteTopLevel(before[k + 1]!, reg, value) : before[k + 1]!;
    if (!sameStmt(expected, after[k]!)) return false;
  }
  return true;
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

  // The exact substituted value, over the whole list but without rebuilding
  // it (see `verifyExpectedShape`): after this, `after` is known to be
  // `before` with the region `[i, hiBefore)` replaced by `[i, hiAfter)` and
  // every other position unchanged, which is what the bounded read/write
  // delta below relies on.
  if (!verifyExpectedShape(before, after, verdict.rule, i, verdict.j, reg, value)) {
    return { ok: false, reason: "the rewrite did not fold in the expected value" };
  }

  // Item 4: the exact read/write delta. Writes always drop by one (the store
  // itself). Reads drop by one for R1a (the folded read is now gone - E's own
  // reads of `reg`, if any, simply relocate from `i` to `j`, netting zero);
  // for R1b/R1c reads drop only by however many times `E` itself read `reg`
  // and got *deleted* (pure) - an impure R1b keeps `E` (and its reads) alive.
  const eSelfReads = exprCounts(value, reg).reads;
  const expectedReadDelta = verdict.rule === "R1a" ? 1 : isPure(value) ? eSelfReads : 0;
  const impureStore = verdict.rule === "R1b" && !isPure(value);
  const hiBefore = verdict.rule === "R1a" ? verdict.j + 1 : i + 1;
  const hiAfter = verdict.rule === "R1a" ? verdict.j : impureStore ? i + 1 : i;
  const beforeMid = registerUses(before.slice(i, hiBefore));
  const afterMid = registerUses(after.slice(i, hiAfter));
  const delta = registerUseDelta(beforeMid, afterMid, reg);
  if (delta.writes !== 1) return { ok: false, reason: `rewrite did not remove exactly one write of ${reg}` };
  if (delta.reads !== expectedReadDelta) return { ok: false, reason: `rewrite did not remove the expected read of ${reg}` };

  // The site is accepted, so the driver is about to make `after` the new
  // `ctx.fnBody`. Carry the whole-function register-use map across the
  // splice rather than letting the next iteration rebuild it: the same two
  // window maps the delta above just used are exactly what
  // `noteRegisterUsesSplice` needs, and `verifyExpectedShape` has already
  // proven every position outside `[i, hiBefore)`/`[i, hiAfter)` unchanged,
  // which is that derivation's whole premise. `docs/BUGS.md`'s
  // superlinear-pass row, part 5.
  noteRegisterUsesSplice(before, after, beforeMid, afterMid);

  return { ok: true };
}
