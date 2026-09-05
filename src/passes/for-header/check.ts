// for-header checker. The rewrite is an annotation, so the driver's round-trip
// proves nothing here: this is the whole guard. Two things must hold — the tree
// is untouched, and a `do … while` promoted to `while` really did have a
// statically-true first test (otherwise the loop would run its body one time
// too few).
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { firstTestHolds, sameShape } from "../tree.ts";
import { match } from "./match.ts";

/** The rewrite may change nothing but the annotation. */
export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (!sameShape(before, after)) return { ok: false, reason: "for-header changed the tree shape" };
  if (after.k !== "loop" || after.form === undefined) return { ok: false, reason: "missing init/step annotation" };
  if (after.form.kind !== "while" && after.form.kind !== "do-while") return { ok: false, reason: "for-header rewrote a non-while loop form" };
  if (after.form.init === undefined || after.form.step === undefined) return { ok: false, reason: "missing init/step annotation" };
  if (before.k !== "loop" || before.form === undefined) return { ok: false, reason: "for-header ran on an unformed loop" };
  if (before.form.kind !== "while" && before.form.kind !== "do-while") return { ok: false, reason: "for-header ran on a non-while loop form" };
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
  // Re-derive the init/step slices the matcher itself would find for `before`
  // (recompute; never trust the writer's own annotation, same discipline as
  // expr-rebuild/check.ts) — `match` is a pure function of `(before, ctx)`
  // and `check` always runs with the very same `ctx` `match` did, so for any
  // genuine site this reproduces the original `ForSite` exactly. A wrong or
  // missing `form.step` (or `form.init`) diverges from it here — the field
  // `check` never inspected before (docs/BUGS.md checker-mutation-stagea row).
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "for-header rewrite has no matching site to re-derive init and step from the site" };
  if (m.data.init.cfgBlock !== after.form.init.cfgBlock || m.data.init.from !== after.form.init.from) return { ok: false, reason: "for-header attached the wrong init block" };
  if (m.data.step.cfgBlock !== after.form.step.cfgBlock || m.data.step.from !== after.form.step.from) return { ok: false, reason: "for-header attached the wrong step block" };
  return { ok: true };
}
