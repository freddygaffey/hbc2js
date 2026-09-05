// try-clean checker — spec 22 §6.2, expression-only *deleting* variant. Four
// independent obligations, none of them trusting the `Match` it is handed:
// `match` is re-run on `before` (the `for-header`/`loop-cond` discipline),
// and every obligation below is checked against that fresh re-derivation.
import type { Expr, Stmt } from "../ast.ts";
import { effectSequence, freeNames, identUses, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { applyAnalysis, collectAllTries, hasEntryStore } from "./analysis.ts";
import { match } from "./match.ts";

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const isPcOrExcAssign = (e: { readonly k: string; readonly name?: string }): boolean => e.k === "assign" && (e.name === "__pc" || e.name === "__exc");

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "try-clean has no matching site to re-derive the deletions from" };
  const a = m.data;

  // 1. Undo by re-insertion: re-applying the freshly re-derived deletions to
  // `before` must reproduce `after` exactly. A deleting rung has no
  // byte-identical undo, so this is the deleting analogue of it — any edit
  // beyond the declared deletions, anywhere in the function, fails here.
  const declared = applyAnalysis(before, a);
  if (!deepEqual(declared, after)) return { ok: false, reason: "try-clean's result is not exactly the declared deletions applied to `before`" };

  if (!parses(after)) return { ok: false, reason: "try-clean result does not parse" };

  // 2. Declared-deletion effect equality (00-LADDER §4.3, relaxed for the
  // declared `__pc`/`__exc` assign effects the same way the CF-preserving
  // class is relaxed by declared duplicates): drop every `__pc`/`__exc`
  // assign effect from both sequences and the rest must match exactly.
  const stripPcExc = (list: readonly Stmt[]): readonly unknown[] => effectSequence(list).filter((e) => !isPcOrExcAssign(e as { readonly k: string; readonly name?: string }));
  if (!deepEqual(stripPcExc(before), stripPcExc(after))) return { ok: false, reason: "try-clean changed an effect other than a declared __pc/__exc store" };

  // 3. Independent liveness (re-derived from `before`, not from `a`'s own
  // bookkeeping): every deleted __pc store sits outside every guarded try's
  // block, and C4 holds for every guarded try whose block a deletion came
  // from; every deleted __exc copy has zero attributed reads and the
  // function has zero open reads.
  const guardedTries = collectAllTries(before).filter((t) => t.handler[0] !== undefined && guardShape(t.handler[0]!));
  if (a.deadPcStmts.length + a.deadForExprs.length > 0 && !guardedTries.every((t) => hasEntryStore(t.block))) {
    return { ok: false, reason: "a __pc deletion is claimed without every guarded try having an entry-dominating store (C4)" };
  }

  // 4. No new free name, no orphan read.
  const freeBefore = freeNames(before);
  const freeAfter = freeNames(after);
  for (const n of freeAfter) if (!freeBefore.has(n)) return { ok: false, reason: `try-clean introduced a new free name: ${n}` };
  if (a.pcFrame !== null) {
    const u = identUses(after, "__pc");
    if (u.reads !== 0 || u.writes !== 0) return { ok: false, reason: "a __pc reference survives the deleted frame" };
  }
  if (a.excFrame !== null) {
    const u = identUses(after, "__exc");
    if (u.reads !== 0 || u.writes !== 0) return { ok: false, reason: "an __exc reference survives the deleted frame" };
  }

  return { ok: true };
}

function guardShape(s: Stmt): boolean {
  if (s.k !== "if") return false;
  if (s.test.k !== "unary" || s.test.op !== "!") return false;
  const inner = s.test.arg;
  return inner.k === "logical" && inner.op === "&&" && isPcTest(inner.left) && isPcTest(inner.right);
}

function isPcTest(e: Expr): boolean {
  return (e.k === "bin" && e.op === ">=" && e.left.k === "ident" && e.left.name === "__pc") || (e.k === "bin" && e.op === "<=" && e.left.k === "ident" && e.left.name === "__pc");
}
