// for-header matcher — docs/LOWERING-CATALOGUE.md row 4.
//
// After loop-cond: a `while (c)` loop whose falling-in block ends with writes
// to the registers `c` reads (the init) and whose body's last block ends with
// writes to those same registers (the step). Only a readability judgement — the
// rewrite moves no instruction, it tells the emitter which slices to print in
// the `for` head. Refuses when the body has any other `continue` (a JS
// `continue` in a `for` runs the step; the tree's `continue` does not).
import type { Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import type { BlockId, Instruction } from "../tree.ts";
import { condInputs, firstTestHolds, instructionsOf, usesOf, writtenRegisters } from "../tree.ts";

export interface ForSite {
  readonly loop: Stmt & { readonly k: "loop" };
  readonly init: { readonly cfgBlock: BlockId; readonly from: number };
  readonly step: { readonly cfgBlock: BlockId; readonly from: number };
  /**
   * The loop-cond form was `do-while` and this pass proved the first test
   * holds, so the rewrite promotes it to `while` — `for (init; c; step) B`
   * is `init; while (c) { B; step }`, which is the rotated loop exactly when
   * the pre-test hermesc folded away was true. `check` re-proves it.
   */
  readonly promoted: boolean;
}

export type ForMatch = Match<Stmt, ForSite>;

/** Instructions plain enough to sit in a `for` head as one assignment each. */
const HEAD_OPS = /^(LoadConst(Zero|UInt8|Int|Double|True|False|Null|Undefined|String)|Mov|Inc|Dec|Add|AddN|Sub|SubN|Mul|MulN|Div|DivN|Add32|Sub32|Inc32|Dec32|ToNumber|ToNumeric|Negate)$/;

export function match(node: Stmt, ctx: PassContext): ForMatch | null {
  if (node.k !== "loop" || node.form === undefined || node.form.init !== undefined || node.form.step !== undefined) return null;
  const fn = ctx.structured;
  if (fn === undefined) return null;
  if (usesOf(node.body, node.label).continues > 1) return null;
  const at = ctx.parentOf?.(node);
  if (!at || (at.parent as Stmt).k !== "seq") return null;
  const pred = (at.parent as Stmt & { k: "seq" }).body[at.index - 1];
  if (pred === undefined || pred.k !== "block" || fn.duplicatedBlocks.includes(pred.cfgBlock)) return null;

  const condInsns = instructionsOf(fn, node.form.cond);
  if (condInsns === null || condInsns.length === 0) return null;
  const regs = condInputs(condInsns[condInsns.length - 1]!);
  if (regs === null || regs.length === 0) return null;

  const predInsns = instructionsOf(fn, pred.cfgBlock);
  if (predInsns === null) return null;
  const initFrom = sliceStart(predInsns, predInsns.length, regs);
  if (initFrom === null) return null;

  const body = node.body.k === "seq" ? node.body.body : [node.body];
  let stepBlock: BlockId;
  let stepEnd: number;
  if (node.form.at === "tail") {
    // tail form: the step is the straight-line part of the test block.
    stepBlock = node.form.cond;
    stepEnd = condInsns.length - 1;
  } else {
    // head form: the body's last block (optionally followed by `continue L`).
    let last = body[body.length - 1];
    if (last?.k === "continue") last = body[body.length - 2];
    if (last === undefined || last.k !== "block" || fn.duplicatedBlocks.includes(last.cfgBlock)) return null;
    if (usesOf(node.body, node.label).continues !== (body[body.length - 1]?.k === "continue" ? 1 : 0)) return null;
    stepBlock = last.cfgBlock;
    stepEnd = instructionsOf(fn, stepBlock)?.length ?? 0;
  }
  const stepInsns = instructionsOf(fn, stepBlock);
  if (stepInsns === null) return null;
  const stepFrom = sliceStart(stepInsns, stepEnd, regs);
  if (stepFrom === null) return null;

  // A `do … while` only becomes a `for` if its pre-test was folded, i.e. the
  // test held on entry. Unprovable -> leave it as the `do … while` it is.
  const promoted = node.form.kind === "do-while";
  if (promoted && !firstTestHolds(fn, pred.cfgBlock, node.form.cond, node.form.negate, ctx.functionIndex)) return null;

  const start = fn.graph.blocks[node.form.cond]?.block?.start ?? 0;
  return { root: node, nodes: [node], data: { loop: node, init: { cfgBlock: pred.cfgBlock, from: initFrom }, step: { cfgBlock: stepBlock, from: stepFrom }, promoted }, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/** Start of the longest suffix of `insns[0, end)` made of plain writes to `regs`; null when empty. */
function sliceStart(insns: readonly Instruction[], end: number, regs: readonly number[]): number | null {
  let from = end;
  while (from > 0) {
    const insn = insns[from - 1]!;
    const w = writtenRegisters(insn);
    if (!HEAD_OPS.test(insn.name) || w.length !== 1 || !regs.includes(w[0]!)) break;
    from--;
  }
  return from === end ? null : from;
}
