// for-in checker — annotation-only (LADDER §4.3). §6 of spec 21.
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { registerLiveAfter, sameShape } from "../tree.ts";
import { match } from "./match.ts";

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (!sameShape(before, after)) return { ok: false, reason: "for-in changed the tree shape" };
  if (before.k !== "loop" || before.form !== undefined) return { ok: false, reason: "for-in ran on an already-formed loop" };
  if (after.k !== "loop" || after.form === undefined || after.form.kind !== "for-in") return { ok: false, reason: "missing for-in annotation" };
  const form = after.form;

  // Recompute — never trust the writer.
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "for-in rewrite has no matching site to re-derive the annotation from" };
  const want = m.data.form;
  if (form.cond !== want.cond || form.iter !== want.iter || form.setup !== want.setup || form.negate !== want.negate || form.binding !== want.binding || form.source !== want.source) {
    return { ok: false, reason: "for-in annotation does not match the recomputed site" };
  }
  if (form.close.length !== want.close.length || form.close.some((b, i) => b !== want.close[i])) {
    return { ok: false, reason: "for-in annotation dropped or reordered a close block" };
  }

  // The semantic predicate the annotation asserts (§6.4): the binding is not
  // live past the loop's exhaustion branch.
  const fn = ctx.structured;
  if (fn === undefined) return { ok: false, reason: "no structured function to check against" };
  const exit = fn.graph.cfg.blocks[form.cond]?.succs.find((s) => s.kind === "branch-taken")?.to;
  if (exit === undefined || registerLiveAfter(fn, exit, 0, form.binding)) {
    return { ok: false, reason: "for-in binding is live after the loop" };
  }
  return { ok: true };
}
