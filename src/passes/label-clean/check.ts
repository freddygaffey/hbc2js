// label-clean checker — docs/specs/passes/06-label-clean.md §6. `check` gets
// only `before`/`after` (no match data), so every obligation is re-derived
// from `before` alone, never trusted from whichever rule fired in `match`.
// Dispatch is by `before.k`, which is exactly what distinguishes L1/L2 (a
// `labeled` node) from L3 (a `loop`) from L4 (a `seq`).
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { blocksMultiset, sameShape, usesOf } from "../tree.ts";
import { checkInnermostTargets, deleteTailBreaks, stmtEqual } from "./match.ts";
import type { LoopNode } from "./match.ts";

function multisetsEqual(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function check(before: Stmt, after: Stmt, _ctx: PassContext): CheckResult {
  // Obligation 1: no `block`/`if`/`return`/`throw`/`switch`/`try` leaf added,
  // removed or duplicated — true by construction for every rule here (only
  // `labeled`, `seq`, `break` and `loop.hideLabel` are ever touched), but
  // asserted rather than assumed.
  if (!multisetsEqual(blocksMultiset(before), blocksMultiset(after))) return { ok: false, reason: "block multiset changed" };

  if (before.k === "labeled") {
    // Obligation 3: re-derive the tail set on `before`, independent of
    // whatever `match`/`rewrite` computed.
    if (usesOf(before.body, before.label).continues > 0) return { ok: false, reason: "continue-to-own-label" };
    const expected = deleteTailBreaks(before.body, before.label);
    if (!stmtEqual(after, expected)) return { ok: false, reason: "break-not-in-tail" };
    // Obligation 2 (the local part): the removed label must not still be
    // referenced anywhere in this rewrite's own output.
    const remaining = usesOf(after, before.label);
    if (remaining.breaks > 0 || remaining.continues > 0) return { ok: false, reason: "label-still-referenced" };
    return { ok: true };
  }

  if (before.k === "loop") {
    if (after.k !== "loop" || after.hideLabel !== true) return { ok: false, reason: "not a hideLabel rewrite" };
    // Obligation 4: annotation-only — the tree is otherwise untouched.
    if (!sameShape(before, after) || before.form !== after.form) return { ok: false, reason: "loop shape changed" };
    const innermost = checkInnermostTargets(before as LoopNode);
    if (!innermost.ok) return innermost;
    return { ok: true };
  }

  if (before.k === "seq") {
    if (before.body.length !== 1) return { ok: false, reason: "not a single-element seq" };
    if (!stmtEqual(after, before.body[0]!)) return { ok: false, reason: "unwrap mismatch" };
    return { ok: true };
  }

  return { ok: false, reason: "unexpected node kind for label-clean" };
}
