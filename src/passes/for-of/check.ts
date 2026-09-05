// for-of checker — annotation-only (LADDER §4.3). §6 of spec 21.
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { registerLiveAfter, sameShape } from "../tree.ts";
import { match } from "./match.ts";

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (!sameShape(before, after)) return { ok: false, reason: "for-of changed the tree shape" };
  if (before.k !== "loop" || before.form !== undefined) return { ok: false, reason: "for-of ran on an already-formed loop" };
  if (after.k !== "loop" || after.form === undefined || after.form.kind !== "for-of") return { ok: false, reason: "missing for-of annotation" };
  const form = after.form;

  // Recompute — never trust the writer.
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "for-of rewrite has no matching site to re-derive the annotation from" };
  const want = m.data.form;
  if (form.cond !== want.cond || form.iter !== want.iter || form.setup !== want.setup || form.negate !== want.negate || form.binding !== want.binding || form.source !== want.source) {
    return { ok: false, reason: "for-of annotation does not match the recomputed site" };
  }
  if (form.close.length !== want.close.length || form.close.some((b, i) => b !== want.close[i])) {
    return { ok: false, reason: "for-of annotation dropped, added or reordered a close block" };
  }

  // §6.4: `state` is not read after any drop-candidate `IteratorClose`, nor
  // live at the loop's normal exit.
  const fn = ctx.structured;
  if (fn === undefined) return { ok: false, reason: "no structured function to check against" };
  const exit = fn.graph.cfg.blocks[form.cond]?.succs.find((s) => s.kind === "branch-taken")?.to;
  if (exit === undefined) return { ok: false, reason: "for-of loop has no resolvable exit edge" };
  if (registerLiveAfter(fn, exit, 0, form.binding)) return { ok: false, reason: "for-of binding is live after the loop" };
  if (form.close.length === 0) return { ok: false, reason: "for-of annotation dropped no IteratorClose block" };
  for (const b of form.close) {
    const insns = fn.graph.blocks[b]?.block?.instructions;
    const closeIdx = insns?.findIndex((i) => i.name === "IteratorClose") ?? -1;
    const state = closeIdx < 0 ? undefined : insns![closeIdx]!.operands[0];
    if (state === undefined || state.role !== "reg") return { ok: false, reason: "for-of close block has no resolvable IteratorClose" };
    if (registerLiveAfter(fn, exit, 0, state.value)) return { ok: false, reason: "for-of iteration state is live after the loop" };
    if (registerLiveAfter(fn, b, closeIdx + 1, state.value)) return { ok: false, reason: "for-of iteration state is read after a dropped IteratorClose" };
  }
  return { ok: true };
}
