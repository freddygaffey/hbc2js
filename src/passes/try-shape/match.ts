// try-shape matcher — docs/specs/passes/22-try-shape-try-clean.md §4.1,
// catalogue row 11. Stage A, annotation-only: refuses generously, writes
// nothing but the `shape` field the writer copies onto the node.
import type { Stmt } from "../../structure/ir.ts";
import type { TryShape } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { blocksOf, canThrow, instructionsOf, writtenRegisters } from "../tree.ts";
import type { Instruction } from "../tree.ts";

export type TryNode = Stmt & { readonly k: "try" };
export type TryShapeMatch = Match<Stmt, TryShape>;

export function match(node: Stmt, ctx: PassContext): TryShapeMatch | null {
  if (node.k !== "try") return null;
  if (node.shape !== undefined) return null; // P0 (already-annotated, PL-08)
  if (ctx.structured === undefined) return null; // no-structured-context
  const region = ctx.structured.graph.cfg.regions[node.region];
  if (region === undefined || region.bodyBlocks.size === 0) return null; // region-missing
  if (node.cfgBlock < 0) return null; // dispatch-nest (P2, §4.4)

  const guardRedundant = isGuardRedundant(node, ctx);
  const handlerReads = handlerReadsCatchRegister(node, ctx);

  if (!guardRedundant && handlerReads) return null; // nothing-to-say: neither annotation applies

  const shape: TryShape = { bindsExc: handlerReads, guard: guardRedundant ? "redundant" : "needed" };
  return { root: node, nodes: [node], data: shape, at: { functionIndex: ctx.functionIndex, offset: siteOffset(node, ctx) } };
}

/**
 * §4.1's guard-redundant predicate: for every block of `node.body` outside
 * `region.bodyBlocks` (skipping synthetic try-heads, the same walk
 * `src/emit/function.ts`'s `planTries` does), the block is either inside the
 * region's `[lo, hi]` id range or none of its instructions can throw.
 */
function isGuardRedundant(node: TryNode, ctx: PassContext): boolean {
  const structured = ctx.structured!;
  const region = structured.graph.cfg.regions[node.region]!;
  const ids = [...region.bodyBlocks];
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  for (const b of blocksOf(node.body)) {
    if (region.bodyBlocks.has(b)) continue;
    if (structured.graph.blocks[b]?.block === null) continue; // synthetic try-head: no bytes, cannot throw
    if (b >= lo && b <= hi) continue;
    const insns = instructionsOf(structured, b) ?? [];
    if (insns.some((insn) => canThrow(insn))) return false;
  }
  return true;
}

/**
 * §4.1's `bindsExc` predicate: does any instruction anywhere in the handler
 * subtree (at any depth, including a nested `try`'s own handler) read
 * `node.catchRegister`? The leading `Catch <catchRegister>` is a write and
 * never counts as a read.
 *
 * Refuses (conservatively answers "reads", i.e. `bindsExc` stays `true`)
 * whenever the region's real handler block (`region.handlerBlock`, where the
 * physical `Catch` instruction lives) is not reachable inside `node.handler`
 * at all: `src/structure/augment.ts` §4.5 says a handler shared by several
 * regions becomes one merge point that every sharing region's tree node
 * reaches only via a `break` to it — the real handler code, and any read of
 * the exception it does, is not textually inside *this* node's `handler`
 * subtree, so this rung cannot see it and must not claim it is unread. The
 * emitter's `__exc = _excN` copy this try's handler would otherwise lose is
 * exactly the bridge that merge point's own `Catch` lowering (`r = __exc`)
 * reads from — dropping it silently reads a stale `__exc`. Caught during
 * this rung's own implementation by the T2 equivalence gate on fixture 14's
 * `f2` (a shared handler reached via `break L1`, per `src/cfg/exceptions.ts`
 * step 8's `sharesHandlerWith` grouping) before it ever landed; fixed here,
 * so no BUGS.md row is needed.
 */
function handlerReadsCatchRegister(node: TryNode, ctx: PassContext): boolean {
  const structured = ctx.structured!;
  const region = structured.graph.cfg.regions[node.region]!;
  const handlerBlocks = blocksOf(node.handler);
  if (!handlerBlocks.includes(region.handlerBlock) || region.sharesHandlerWith.length > 0) return true; // shared/merge-point handler: cannot see the real code
  for (const b of handlerBlocks) {
    if (structured.graph.blocks[b]?.block === null) continue;
    const insns = instructionsOf(structured, b) ?? [];
    for (const insn of insns) if (instructionReadsRegister(insn, node.catchRegister)) return true;
  }
  return false;
}

/**
 * `true` when `insn` reads register `reg`: any non-primary register operand
 * counts as a read unconditionally (a deliberately conservative
 * over-approximation for the rare `[in/out]` extra-dest opcodes — see
 * `src/cfg/reg-effects.ts`'s `EXTRA_DESTS`, not on `src/passes`'s import
 * allowlist); operand 0 counts as a read only when `writtenRegisters` does
 * not already claim it as this instruction's (pure) destination — which is
 * exactly what makes `Catch <reg>`'s own write never count as a read of the
 * register it just defined.
 */
function instructionReadsRegister(insn: Instruction, reg: number): boolean {
  return insn.operands.some((op, i) => {
    if (op.role !== "reg" || op.value !== reg) return false;
    if (i !== 0) return true;
    return !writtenRegisters(insn).includes(reg);
  });
}

function siteOffset(node: Stmt, ctx: PassContext): number {
  if (ctx.structured === undefined) return 0;
  const first = blocksOf(node)[0];
  if (first === undefined) return 0;
  return ctx.structured.graph.blocks[first]?.block?.start ?? 0;
}
