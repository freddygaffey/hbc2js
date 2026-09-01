// loop-cond checker. The driver already re-runs spec 04 §5's round-trip on the
// whole function after splicing; this is the site-local part: the same CFG
// blocks, in the same order, and the annotation points at a guard that is
// still in the loop. A head-form loop additionally asserts its test block
// carries nothing but the jump (the assumption the rewrite made).
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { blocksOf, instructionsOf } from "../tree.ts";
import { postOrder } from "../driver.ts";
import { match } from "./match.ts";

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
  // Re-derive the shape (head -> while, tail(-labeled) -> do-while, `match.ts`'s
  // deterministic mapping) and the test's polarity the matcher would find for
  // `before` itself (recompute; never trust the writer's own annotation, same
  // discipline as expr-rebuild/check.ts and for-header/check.ts). `match` is a
  // pure function of `(before, ctx)` and `check` always runs with the same
  // `ctx` `match` did, so for any genuine site this reproduces the original
  // `LoopSite` exactly. A flipped `form.kind` or `form.negate` diverges from
  // it here — fields `check` never inspected before (docs/BUGS.md
  // checker-mutation-stagea row).
  if (ctx.structured !== undefined) {
    const m = match(before, ctx);
    if (m === null) return { ok: false, reason: "loop-cond rewrite has no matching site to re-derive kind and negate from the site" };
    if (m.data.kind !== loop.form!.kind) return { ok: false, reason: "loop-cond changed the while/do-while kind" };
    if (m.data.negate !== loop.form!.negate) return { ok: false, reason: "loop-cond changed the test polarity" };
  }
  return { ok: true };
}
