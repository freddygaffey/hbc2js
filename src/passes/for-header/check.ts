// for-header checker. The rewrite is an annotation, so the driver's round-trip
// proves nothing here: this is the whole guard. Two things must hold — the tree
// is untouched, and a `do … while` promoted to `while` really did have a
// statically-true first test (otherwise the loop would run its body one time
// too few).
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { firstTestHolds, sameShape } from "../tree.ts";

/** The rewrite may change nothing but the annotation. */
export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (!sameShape(before, after)) return { ok: false, reason: "for-header changed the tree shape" };
  if (after.k !== "loop" || after.form?.init === undefined || after.form.step === undefined) return { ok: false, reason: "missing init/step annotation" };
  if (before.k !== "loop" || before.form === undefined) return { ok: false, reason: "for-header ran on an unformed loop" };
  if (before.form.cond !== after.form.cond || before.form.at !== after.form.at || before.form.negate !== after.form.negate) return { ok: false, reason: "loop test changed" };
  if (before.form.kind === "do-while" && after.form.kind === "while") {
    const fn = ctx.structured;
    const at = fn === undefined ? null : (ctx.parentOf?.(before) ?? null);
    const parent = at?.parent as Stmt | undefined;
    const pred = parent?.k === "seq" ? parent.body[at!.index - 1] : undefined;
    if (fn === undefined || pred === undefined || pred.k !== "block" || pred.cfgBlock !== after.form.init.cfgBlock) return { ok: false, reason: "promoted loop has no init block in front of it" };
    if (!firstTestHolds(fn, pred.cfgBlock, after.form.cond, after.form.negate, ctx.functionIndex)) return { ok: false, reason: "do-while -> for needs a statically-true first test" };
  } else if (before.form.kind !== after.form.kind) {
    return { ok: false, reason: "for-header changed the loop kind" };
  }
  return { ok: true };
}
