// loop-cond checker. The driver already re-runs spec 04 §5's round-trip on the
// whole function after splicing; this is the site-local part: the same CFG
// blocks, in the same order, and the annotation points at a guard that is
// still in the loop. A head-form loop additionally asserts its test block
// carries nothing but the jump (the assumption the rewrite made).
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { blocksOf, instructionsOf } from "../tree.ts";
import { postOrder } from "../driver.ts";

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  const a = blocksOf(before);
  const b = blocksOf(after);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return { ok: false, reason: "block sequence changed" };
  const loop = postOrder(after).find((n): n is Stmt & { k: "loop" } => n.k === "loop" && n.form !== undefined);
  if (loop === undefined) return { ok: false, reason: "no annotated loop in the rewrite" };
  const guard = postOrder(loop.body).find((n) => n.k === "if" && n.cfgBlock === loop.form!.cond);
  if (guard === undefined) return { ok: false, reason: "annotated test is not inside the loop" };
  if (ctx.structured !== undefined) {
    const insns = instructionsOf(ctx.structured, loop.form!.cond);
    if (insns === null) return { ok: false, reason: "test block is synthetic" };
    const body = loop.body.k === "seq" ? loop.body.body : [loop.body];
    const where = loop.form!.at === "head" ? body[1] : body[body.length - 1];
    if (where !== guard) return { ok: false, reason: `annotated test is not at the loop ${loop.form!.at}` };
    if (loop.form!.at === "head" && insns.length !== 1) return { ok: false, reason: "head test block has straight-line instructions" };
  }
  return { ok: true };
}
