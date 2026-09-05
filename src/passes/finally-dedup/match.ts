// finally-dedup matcher -- docs/specs/passes/30-finally-dedup.md sections 2, 4
// and 6, catalogue lowering row 12. Stage A, annotation-only: it writes a
// `FinallyForm` onto the `try` node and moves nothing.
import type { FinallyForm, FinallyRange, Stmt } from "../../structure/ir.ts";
import type { BlockId, Instruction } from "../tree.ts";
import type { Match, PassContext } from "../types.ts";
import { blocksOf, registerLiveAfter, writtenRegisters } from "../tree.ts";

export type TryNode = Stmt & { readonly k: "try" };

/**
 * Spec 30 section 1 fact 2, as amended by the v96 diagnosis (docs/BUGS.md
 * "finally-dedup v96 copies not opcode-identical"): two instruction ranges are
 * copies of one source statement when their opcodes and every non-register
 * operand agree, and their register operands agree under a bijection that is
 * **rebound at each definition** -- a register's correspondence holds from the
 * instruction that writes it until the next one does. A single bijection over
 * the whole range (what LADDER 5.1's `sameCode` and this spec's own evidence
 * detector used) is too strong: at v96 the handler-side copy reuses the
 * parameter register `r1` as a scratch destination part-way through, so `r1`
 * has to map to itself while it holds the parameter and to `r2` afterwards.
 */
export function isomorphicModuloRegisters(a: readonly Instruction[], b: readonly Instruction[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const fwd = new Map<number, number>();
  const back = new Map<number, number>();
  const bindRead = (x: number, y: number): boolean => {
    if ((fwd.get(x) ?? y) !== y || (back.get(y) ?? x) !== x) return false;
    fwd.set(x, y);
    back.set(y, x);
    return true;
  };
  const bindWrite = (x: number, y: number): void => {
    const staleY = fwd.get(x);
    if (staleY !== undefined) back.delete(staleY);
    const staleX = back.get(y);
    if (staleX !== undefined) fwd.delete(staleX);
    fwd.set(x, y);
    back.set(y, x);
  };
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.name !== y.name || x.operands.length !== y.operands.length) return false;
    const wx = writtenRegisters(x);
    const wy = writtenRegisters(y);
    const isDest = (insn: Instruction, written: readonly number[], j: number): boolean => j === 0 && insn.operands[0]!.role === "reg" && written.includes(insn.operands[0]!.value);
    for (let j = 0; j < x.operands.length; j++) {
      const ox = x.operands[j]!;
      const oy = y.operands[j]!;
      if (ox.role !== oy.role || ox.type !== oy.type) return false;
      if (ox.role !== "reg") {
        if (ox.value !== oy.value) return false;
        continue;
      }
      if (isDest(x, wx, j) !== isDest(y, wy, j)) return false;
      if (isDest(x, wx, j)) continue; // a definition: rebound below, after every read of this instruction
      if (!bindRead(ox.value, oy.value)) return false;
    }
    for (let j = 0; j < x.operands.length; j++) {
      if (!isDest(x, wx, j)) continue;
      bindWrite(x.operands[j]!.value, y.operands[j]!.value);
    }
  }
  return true;
}

/**
 * Cheap, purely local answer to "is `reg` still read after index `to` of this
 * block?": a read before any write says yes, a write before any read says no,
 * and a block that ends the function (`return`/`throw`) says no. `undefined`
 * means the question escapes the block and the caller must fall back to the
 * whole-CFG `registerLiveAfter` walk -- which is the expensive one, and which
 * this keeps off the hot path (the pipeline-speed budget, P-1).
 */
function liveAfterRange(ins: readonly Instruction[], to: number, reg: number): boolean | undefined {
  for (let j = to; j < ins.length; j++) {
    const insn = ins[j]!;
    const written = writtenRegisters(insn);
    if (insn.operands.some((op, k) => op.role === "reg" && op.value === reg && !(k === 0 && written.includes(reg)))) return true;
    if (written.includes(reg)) return false;
  }
  const last = ins[ins.length - 1];
  return last !== undefined && (last.kind === "return" || last.kind === "throw") ? false : undefined;
}

export function match(node: Stmt, ctx: PassContext): Match<Stmt, FinallyForm> | null {
  if (node.k !== "try") return null;
  if (node.finalizer !== undefined) return null; // already folded (PL-08 fixed point)
  const structured = ctx.structured;
  if (structured === undefined) return null;
  const region = structured.graph.cfg.regions[node.region];
  if (region === undefined || region.bodyBlocks.size === 0) return null;
  const refuse = (code: string): null => {
    ctx.refuse?.(node, code);
    return null;
  };

  // R-FD6: the generator/async dispatcher's forced-return tails are a
  // different duplication (docs/BUGS.md R-Y4 `forced-return-body`).
  if (ctx.cfg.generator.info.kind !== "normal") return refuse("R-FD6 generator-or-async");
  // R-FD5: a dispatch nest's copies are switch arms, not exits.
  if (node.cfgBlock < 0) return refuse("R-FD5 dispatch-nest");
  // R-FD3 (shared handler): src/structure/augment.ts section 4.5 turns a
  // handler shared by several regions into a merge point, so this node's
  // `handler` subtree is not the real handler code at all.
  if (region.sharesHandlerWith.length > 0) return refuse("R-FD3 shared-handler");

  const insnsOf = (b: BlockId): readonly Instruction[] | null => structured.graph.blocks[b]?.block?.instructions ?? null;
  const handlerBlock = region.handlerBlock;
  const h = insnsOf(handlerBlock);
  // R-FD7: not the synthesized shape. The handler subtree must also *be* that
  // one block, so that printing it as the `finally` body prints exactly it.
  if (h === null || h.length < 3) return refuse("R-FD7 handler-not-catch-first");
  if (h[0]!.name !== "Catch" || h[0]!.operands[0]?.value !== region.catchRegister) return refuse("R-FD7 handler-not-catch-first");
  if (node.handler.k !== "throw" && node.handler.k !== "return") return refuse("R-FD7 handler-not-a-leaf");
  if (node.handler.cfgBlock !== handlerBlock) return refuse("R-FD7 handler-not-a-leaf");
  const last = h[h.length - 1]!;

  // Case A: the trailing `Throw <catchRegister>` is the compiler's rethrow,
  // dropped (section 2). Case B: the finalizer ends in its own transfer,
  // which overrides the pending completion and is kept.
  const rethrowOnly = node.handler.k === "throw" && last.kind === "throw" && last.operands[0]?.role === "reg" && last.operands[0].value === region.catchRegister;
  if (!rethrowOnly && node.handler.k !== "return") return refuse("R-FD7 handler-transfer-not-recognised");
  const source: FinallyRange = { cfgBlock: handlerBlock, from: 1, to: rethrowOnly ? h.length - 1 : h.length };
  const fh = h.slice(source.from, source.to);
  if (fh.length === 0) return refuse("R-FD7 empty-finalizer");

  // The exits of the protected range: the leaves of `node.body` whose block is
  // outside `region.bodyBlocks` (the over-reach `try-shape` reasons about).
  const exits = blocksOf(node.body).filter((b) => b !== handlerBlock && !region.bodyBlocks.has(b) && insnsOf(b) !== null);
  if (exits.length === 0) return refuse("R-FD1 no-normal-path-copy");

  const copies: FinallyRange[] = [];
  for (const b of exits) {
    const ins = insnsOf(b)!;
    // Case A takes a prefix (the exit's own transfer follows it); case B takes
    // the whole tail, transfer included -- that transfer *is* the finalizer's.
    const from = rethrowOnly ? 0 : ins.length - fh.length;
    const to = from + fh.length;
    if (from < 0 || to > ins.length) return refuse("R-FD1 copy-does-not-fit");
    if (rethrowOnly && to >= ins.length) return refuse("R-FD2 copy-has-no-own-transfer");
    if (!isomorphicModuloRegisters(fh, ins.slice(from, to))) return refuse("R-FD1 not-isomorphic");

    // R-FD8 (added when this landed; see spec 30 section 6): an instruction of
    // the copy whose destination is still live after the range cannot simply
    // be deleted -- at v96 the copy's leading `Mov` also defines the register
    // the exit's `Ret` reads. Retain it, but only when reordering it across
    // the finalizer body is provably invisible: a `Mov` whose source no other
    // instruction of the range writes and whose destination the `source` range
    // never touches.
    const rangeWrites = new Set<number>();
    for (let i = from; i < to; i++) for (const w of writtenRegisters(ins[i]!)) rangeWrites.add(w);
    const sourceTouches = new Set<number>();
    for (const insn of fh) for (const op of insn.operands) if (op.role === "reg") sourceTouches.add(op.value);
    const retained: number[] = [];
    for (let i = from; i < to; i++) {
      const insn = ins[i]!;
      if (!writtenRegisters(insn).some((w) => liveAfterRange(ins, to, w) ?? registerLiveAfter(structured, b, to, w))) continue;
      if (insn.name !== "Mov") return refuse("R-FD8 copy-defines-a-live-value");
      const src = insn.operands[1];
      const dst = insn.operands[0];
      if (src?.role !== "reg" || dst?.role !== "reg") return refuse("R-FD8 copy-defines-a-live-value");
      if (rangeWrites.has(src.value) || sourceTouches.has(dst.value)) return refuse("R-FD8 copy-defines-a-live-value");
      retained.push(i);
    }
    copies.push(retained.length === 0 ? { cfgBlock: b, from, to } : { cfgBlock: b, from, to, retained });
  }

  // R-FD3 / R-FD4: another region reaching into a copy range or into the
  // handler-side one means two finalizers interleave, or `F` holds its own
  // `try` -- either way a copy would be printed twice.
  const touched = new Set<BlockId>([handlerBlock, ...copies.map((c) => c.cfgBlock)]);
  for (const [i, other] of structured.graph.cfg.regions.entries()) {
    if (i === node.region) continue;
    for (const b of touched) {
      if (other.handlerBlock === b) return refuse("R-FD3 nested-regions-share-a-range");
      if (other.bodyBlocks.has(b)) return refuse("R-FD4 finalizer-contains-a-try");
    }
  }

  const form: FinallyForm = { source, copies, handlerIsRethrowOnly: rethrowOnly };
  return { root: node, nodes: [node], data: form, at: { functionIndex: ctx.functionIndex, offset: structured.graph.blocks[handlerBlock]?.block?.start ?? 0 } };
}
