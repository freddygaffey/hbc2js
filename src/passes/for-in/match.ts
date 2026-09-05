// for-in matcher — docs/specs/passes/21-for-in-for-of.md §4.1, catalogue row 9.
//
// The measured shape (§2.1, byte-identical at every version):
//
//   labeled L0 { if b0 { break L0 } else { loop L1 {
//     block bH ; GetNextPName k, e, obj, idx, size ; JmpUndefined _, k
//     if bH { break L0 } else { <body>; continue L1 }
//   } } }
//
// `loop-cond` never forms this loop (the head block holds two instructions,
// not one), so `node.form === undefined` here always. Because the Ramsey
// structurer sinks the loop entirely into the "still enumerable" arm of the
// outer guard, the outer `if` is not a flat preceding sibling of the loop —
// it is the loop's immediate parent — so this matcher climbs `ctx.parentOf`
// once instead of using `precedingSibling` (for-of's setup block, by
// contrast, genuinely is a flat preceding sibling; see for-of/match.ts).
import type { Instruction } from "../tree.ts";
import type { IterForm, Stmt, StructuredFunction } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { blocksOf, instructionsOf, items, registerLiveAfter, usesOf, writtenRegisters } from "../tree.ts";

export type LoopNode = Stmt & { readonly k: "loop" };
export type IfNode = Stmt & { readonly k: "if" };

export interface ForInSite {
  readonly loop: LoopNode;
  readonly form: IterForm;
}

export type ForInMatch = Match<Stmt, ForInSite>;

export function match(node: Stmt, ctx: PassContext): ForInMatch | null {
  if (node.k !== "loop" || node.form !== undefined) return null; // P0
  const fn = ctx.structured;
  if (fn === undefined) return null; // P1
  if (usesOf(node.body, node.label).continues !== 1) return null; // P2

  // P3: header block + guard.
  const body = items(node.body);
  // The header (`block bH; if bH {...}`) may be the loop's whole body (the
  // measured, real-fixture shape — the continuation is sunk into the
  // guard's non-exit arm) or the first two items of a flatter one where the
  // continuation follows as further siblings; either way the header itself
  // is exactly these first two items.
  if (body.length < 2 || body[0]!.k !== "block" || body[1]!.k !== "if") return null;
  const bH = body[0]!.cfgBlock;
  const guard = body[1] as IfNode;
  if (guard.cfgBlock !== bH) return null;
  const insns = instructionsOf(fn, bH);
  if (insns === null || insns.length !== 2) return null;
  const [getNext, jmp] = insns as readonly [Instruction, Instruction];
  if (getNext.name !== "GetNextPName" || !jmp.name.startsWith("JmpUndefined")) return null;
  const k = regOperand(getNext, 0);
  const e = regOperand(getNext, 1);
  const obj = regOperand(getNext, 2);
  const idx = regOperand(getNext, 3);
  const size = regOperand(getNext, 4);
  if (k === undefined || e === undefined || obj === undefined || idx === undefined || size === undefined) return null;
  const testReg = jmp.operands.find((o) => o.role === "reg")?.value;
  if (testReg !== k) return null; // the guard must test GetNextPName's own destination

  // Which arm of the inner guard leaves the loop? Exactly one of then/else
  // must be a bare `break <label>`.
  const innerThenLabel = soleBreakLabel(guard.then);
  const innerElseLabel = soleBreakLabel(guard.else);
  if ((innerThenLabel === null) === (innerElseLabel === null)) return null;
  const negate = innerThenLabel !== null;
  const innerExitLabel = negate ? innerThenLabel! : innerElseLabel!;

  // P4/P5: find the setup guard. The Ramsey structurer normally sinks the
  // loop into the "still enumerable" arm of an outer `if` (the loop's own
  // parent), fusing "block bS; if bS {...}" into one node whose `cfgBlock`
  // is bS; a flatter shape — `block bS; if bS {...}; loop` as plain
  // siblings — is accepted too (`findSetup` tries both).
  const setup = findSetup(node, ctx);
  if (setup === null || setup.exitLabel !== innerExitLabel) return null; // both guards, same exit (P5)

  // P6: e/idx/size are private enumerator state — written and read by
  // nothing but the GetPNameList/GetNextPName pair, anywhere in the function.
  const setupInsns = instructionsOf(fn, setup.block);
  if (setupInsns === null || setupInsns.length < 2) return null;
  const gpl = setupInsns[setupInsns.length - 2]!;
  const gplJmp = setupInsns[setupInsns.length - 1]!;
  if (gpl.name !== "GetPNameList" || !gplJmp.name.startsWith("JmpUndefined")) return null;
  if (regOperand(gpl, 0) !== e || regOperand(gpl, 1) !== obj || regOperand(gpl, 2) !== idx || regOperand(gpl, 3) !== size) return null;
  // Hermes reuses register numbers across disjoint live ranges (D23's "webs"),
  // so a whole-function scan would refuse on an unrelated earlier/later reuse
  // of the same register number; scope the "private" check to this
  // enumeration's own extent — the setup block *from its `GetPNameList` on*
  // (an earlier statement in the same block may have used the same register
  // number for something else entirely) plus the loop's own subtree.
  const ranges = new Map<number, number>([[setup.block, setupInsns.length - 2]]);
  for (const b of blocksOf(node.body)) if (!ranges.has(b)) ranges.set(b, 0);
  if (!isPrivateEnumeratorState(fn, ranges, e) || !isPrivateEnumeratorState(fn, ranges, idx) || !isPrivateEnumeratorState(fn, ranges, size)) return null;

  // P7: the binding must not escape as outer state. Walked from the
  // exhaustion branch's own target — the CFG's "branch-taken" edge off `bH`,
  // an opcode-level fact independent of how the tree nests `then`/`else` —
  // not from `bH` itself, which would also see `k` read on every iteration
  // of the loop body via the *continue* edge and always report "live".
  const exit = fn.graph.cfg.blocks[bH]?.succs.find((s) => s.kind === "branch-taken")?.to;
  if (exit === undefined || registerLiveAfter(fn, exit, 0, k)) return null;

  const form: IterForm = { kind: "for-in", cond: bH, at: "head", negate, iter: bH, setup: setup.block, close: [], binding: k, source: obj };
  const start = fn.graph.blocks[bH]?.block?.start ?? 0;
  return { root: node, nodes: [node, guard], data: { loop: node, form }, at: { functionIndex: ctx.functionIndex, offset: start } };
}

/**
 * The block whose tail is `GetPNameList`/`IteratorBegin` for this loop, and
 * the label its exhaustion guard shares with the loop's own header guard
 * (§4.1 P4/P5). Two shapes are accepted: the loop nested inside one arm of
 * an outer `if` (the structurer's usual sink, `bS`'s block and guard fused
 * into one node), or a flat run of siblings `block bS; if bS {...}; loop`.
 */
function findSetup(node: Stmt, ctx: PassContext): { readonly block: number; readonly exitLabel: number } | null {
  const at = ctx.parentOf?.(node);
  if (at === undefined || at === null) return null;
  const parent = at.parent as Stmt;
  if (parent.k === "seq") {
    const guardStmt = parent.body[at.index - 1];
    const blockStmt = parent.body[at.index - 2];
    if (guardStmt?.k !== "if" || blockStmt?.k !== "block" || guardStmt.cfgBlock !== blockStmt.cfgBlock) return null;
    const exitLabel = soleBreakLabel(guardStmt.then) ?? soleBreakLabel(guardStmt.else);
    return exitLabel === null ? null : { block: blockStmt.cfgBlock, exitLabel };
  }
  if (parent.k === "if") {
    const inThen = soleItem(parent.then) === node;
    const inElse = soleItem(parent.else) === node;
    if (inThen === inElse) return null;
    const exitLabel = soleBreakLabel(inThen ? parent.else : parent.then);
    return exitLabel === null ? null : { block: parent.cfgBlock, exitLabel };
  }
  return null;
}

function regOperand(insn: Instruction, i: number): number | undefined {
  const op = insn.operands[i];
  return op?.role === "reg" ? op.value : undefined;
}

/** `items(s)` reduced to its one statement, or `null` when it is not exactly one. */
function soleItem(s: Stmt): Stmt | null {
  const it = items(s);
  return it.length === 1 ? it[0]! : null;
}

/** `s` is exactly one `break L`; returns `L`, else `null`. */
function soleBreakLabel(s: Stmt): number | null {
  const it = soleItem(s);
  return it !== null && it.k === "break" ? it.label : null;
}

/** `register` is written and read by nothing outside `GetPNameList`/`GetNextPName`, anywhere in `fn`. */
function isPrivateEnumeratorState(fn: StructuredFunction, ranges: ReadonlyMap<number, number>, register: number): boolean {
  for (const [id, from] of ranges) {
    const b = fn.graph.cfg.blocks[id];
    if (b === undefined) continue;
    for (const insn of b.instructions.slice(from)) {
      // The header/setup `JmpUndefined` that tests `e`/`k` for exhaustion is
      // part of the idiom itself (§2.1), not an outside touch of the state.
      const isPNameOp = insn.name === "GetPNameList" || insn.name === "GetNextPName" || insn.name.startsWith("JmpUndefined");
      const touches = writtenRegisters(insn).includes(register) || insn.operands.some((o) => o.role === "reg" && o.value === register);
      if (touches && !isPNameOp) return false;
    }
  }
  return true;
}
