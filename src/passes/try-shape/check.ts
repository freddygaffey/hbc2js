// try-shape checker — spec 22 §6.1. Annotation-only (00-LADDER §4.3): the
// rewrite touched nothing but `shape`, so the driver's round-trip proves
// nothing here — this is the whole guard.
import type { Stmt } from "../../structure/ir.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { blocksOf, canThrow, instructionsOf, sameShape, writtenRegisters } from "../tree.ts";
import { match } from "./match.ts";

type TryNode = Stmt & { readonly k: "try" };

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (before.k !== "try" || after.k !== "try") return { ok: false, reason: "check ran on a non-try node" };
  if (!sameShape(before, after)) return { ok: false, reason: "try-shape changed the tree shape" };
  if (before.body !== after.body || before.handler !== after.handler) return { ok: false, reason: "try-shape touched body or handler" };
  if (before.region !== after.region || before.cfgBlock !== after.cfgBlock || before.catchRegister !== after.catchRegister) return { ok: false, reason: "try-shape changed region/cfgBlock/catchRegister" };
  if (after.shape === undefined) return { ok: false, reason: "try-shape produced no annotation" };

  // 2. Re-derive the annotation from `before` and `ctx` — never trust the
  // writer's own annotation (the loop-cond/for-header discipline).
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "try-shape rewrite has no matching site to re-derive the annotation from" };
  if (m.data.bindsExc !== after.shape.bindsExc || m.data.guard !== after.shape.guard) return { ok: false, reason: "try-shape annotation does not match a fresh derivation" };

  // 3. Independently of `match` (a second, separately-written walk — this is
  // what catches a bug in the shared helper, not just a writer that copied
  // `match`'s own answer verbatim).
  if (ctx.structured === undefined) return { ok: false, reason: "try-shape checked without a structured context" };
  const region = ctx.structured.graph.cfg.regions[before.region];
  if (region === undefined) return { ok: false, reason: "try-shape checked a region that no longer exists" };
  const guardRedundant = reWalkGuardRedundant(before as TryNode, ctx);
  if (guardRedundant !== (after.shape.guard === "redundant")) return { ok: false, reason: "re-walked guard predicate disagrees with the annotation" };
  const handlerReads = reScanHandlerReadsCatchRegister(before as TryNode, ctx);
  if (handlerReads !== after.shape.bindsExc) return { ok: false, reason: "re-scanned catch-register read disagrees with the annotation" };

  return { ok: true };
}

function reWalkGuardRedundant(node: TryNode, ctx: PassContext): boolean {
  const structured = ctx.structured!;
  const region = structured.graph.cfg.regions[node.region]!;
  const ids = [...region.bodyBlocks];
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  for (const b of blocksOf(node.body)) {
    if (region.bodyBlocks.has(b)) continue;
    if (structured.graph.blocks[b]?.block === null) continue;
    if (b >= lo && b <= hi) continue;
    const insns = instructionsOf(structured, b) ?? [];
    for (const insn of insns) if (canThrow(insn)) return false;
  }
  return true;
}

function reScanHandlerReadsCatchRegister(node: TryNode, ctx: PassContext): boolean {
  const structured = ctx.structured!;
  const region = structured.graph.cfg.regions[node.region]!;
  const handlerBlocks = blocksOf(node.handler);
  // A shared/merge-point handler's real code is not textually inside this
  // node's `handler` at all (src/structure/augment.ts §4.5) -- conservatively
  // answer "reads" (see match.ts's handlerReadsCatchRegister doc).
  if (!handlerBlocks.includes(region.handlerBlock) || region.sharesHandlerWith.length > 0) return true;
  for (const b of handlerBlocks) {
    if (structured.graph.blocks[b]?.block === null) continue;
    const insns = instructionsOf(structured, b) ?? [];
    for (const insn of insns) {
      const written = writtenRegisters(insn);
      for (let i = 0; i < insn.operands.length; i++) {
        const op = insn.operands[i]!;
        if (op.role !== "reg" || op.value !== node.catchRegister) continue;
        if (i === 0 && written.includes(op.value)) continue;
        return true;
      }
    }
  }
  return false;
}
