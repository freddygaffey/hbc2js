// finally-dedup checker -- docs/specs/passes/30-finally-dedup.md section 4.
// Annotation-only (00-LADDER section 4.3), so the driver's round-trip proves
// nothing: this is the whole guard. The isomorphism is re-derived from the
// CFG by a **separately written** formulation -- an SSA-style canonical
// renumbering of each range, where a register is given a fresh name at every
// definition and reads use the name in force -- so a bug in `match`'s
// bijection bookkeeping cannot be laundered through a checker that just calls
// it again.
import type { Stmt } from "../../structure/ir.ts";
import type { BlockId, Instruction } from "../tree.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { blocksMultiset, sameShape, writtenRegisters } from "../tree.ts";

/** The range `[from, to)` of `ins`, renamed so that the text depends only on
 *  the *pattern* of definitions and uses, never on register numbers. */
function canonical(ins: readonly Instruction[], from: number, to: number): string {
  const name = new Map<number, number>();
  let next = 0;
  const nameOf = (r: number): number => {
    let n = name.get(r);
    if (n === undefined) {
      n = next++;
      name.set(r, n);
    }
    return n;
  };
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const insn = ins[i]!;
    const written = writtenRegisters(insn);
    const parts: string[] = [insn.name];
    const dest = insn.operands[0]?.role === "reg" && written.includes(insn.operands[0].value) ? insn.operands[0].value : null;
    for (let j = 0; j < insn.operands.length; j++) {
      const op = insn.operands[j]!;
      if (op.role !== "reg") {
        parts.push(`${op.role}:${op.type}:${String(op.value)}`);
        continue;
      }
      if (j === 0 && dest !== null) {
        parts.push("dest");
        continue;
      }
      parts.push(`v${nameOf(op.value)}`);
    }
    if (dest !== null) {
      name.set(dest, next++); // a definition renames the register from here on
      parts[1] = `v${name.get(dest)!}`;
    }
    out.push(parts.join(","));
  }
  return out.join(";");
}

export function check(before: Stmt, after: Stmt, ctx: PassContext): CheckResult {
  if (before.k !== "try" || after.k !== "try") return { ok: false, reason: "check ran on a non-try node" };
  if (!sameShape(before, after)) return { ok: false, reason: "finally-dedup changed the tree shape" };
  if (before.body !== after.body || before.handler !== after.handler) return { ok: false, reason: "finally-dedup touched body or handler" };
  if (before.region !== after.region || before.cfgBlock !== after.cfgBlock || before.catchRegister !== after.catchRegister) return { ok: false, reason: "finally-dedup changed region/cfgBlock/catchRegister" };
  const form = after.finalizer;
  if (form === undefined) return { ok: false, reason: "finally-dedup produced no annotation" };
  if (before.finalizer !== undefined) return { ok: false, reason: "finally-dedup re-annotated a folded try" };

  const beforeBlocks = blocksMultiset(before);
  const afterBlocks = blocksMultiset(after);
  if (beforeBlocks.size !== afterBlocks.size) return { ok: false, reason: "finally-dedup changed the block multiset" };
  for (const [b, n] of beforeBlocks) if (afterBlocks.get(b) !== n) return { ok: false, reason: "finally-dedup changed the block multiset" };

  const structured = ctx.structured;
  if (structured === undefined) return { ok: false, reason: "finally-dedup checked without a structured context" };
  const region = structured.graph.cfg.regions[before.region];
  if (region === undefined) return { ok: false, reason: "finally-dedup checked a region that no longer exists" };
  const insnsOf = (b: BlockId): readonly Instruction[] | null => structured.graph.blocks[b]?.block?.instructions ?? null;

  // 1. The source range is exactly the handler's `Catch`-to-transfer interior,
  //    re-derived here rather than read off the annotation (a widened range is
  //    rejected by this, spec 30 section 7 item 8).
  const h = insnsOf(region.handlerBlock);
  if (h === null || h.length < 3) return { ok: false, reason: "finally-dedup annotated a region whose handler is not a block of instructions" };
  if (h[0]!.name !== "Catch") return { ok: false, reason: "finally-dedup annotated a handler that is not Catch-first" };
  const lastIsRethrow = h[h.length - 1]!.kind === "throw" && h[h.length - 1]!.operands[0]?.role === "reg" && h[h.length - 1]!.operands[0]!.value === region.catchRegister;
  if (lastIsRethrow !== form.handlerIsRethrowOnly) return { ok: false, reason: "handlerIsRethrowOnly disagrees with the handler's own terminator" };
  if (form.source.cfgBlock !== region.handlerBlock) return { ok: false, reason: "the finalizer source is not the region's handler block" };
  if (form.source.from !== 1 || form.source.to !== (lastIsRethrow ? h.length - 1 : h.length)) return { ok: false, reason: "the finalizer source range is not the handler's Catch-to-transfer interior" };
  if (form.source.retained !== undefined && form.source.retained.length > 0) return { ok: false, reason: "the finalizer source range retains nothing: it is printed in full" };
  if (form.copies.length === 0) return { ok: false, reason: "finally-dedup annotated a site with no copy to suppress" };

  // 2. Every copy is the same statement, by the independent canonical form.
  const want = canonical(h, form.source.from, form.source.to);
  const seen = new Set<BlockId>();
  for (const c of form.copies) {
    if (seen.has(c.cfgBlock)) return { ok: false, reason: "two finalizer copies claim the same block" };
    seen.add(c.cfgBlock);
    if (c.cfgBlock === region.handlerBlock) return { ok: false, reason: "a finalizer copy is the handler-side range itself" };
    if (region.bodyBlocks.has(c.cfgBlock)) return { ok: false, reason: "a finalizer copy sits inside the protected range" };
    const ins = insnsOf(c.cfgBlock);
    if (ins === null) return { ok: false, reason: "a finalizer copy names a block with no instructions" };
    if (c.from < 0 || c.to > ins.length || c.to - c.from !== form.source.to - form.source.from) return { ok: false, reason: "a finalizer copy range has the wrong extent" };
    if (canonical(ins, c.from, c.to) !== want) return { ok: false, reason: "a finalizer copy is not isomorphic to the handler-side range" };
    // 3. Every copy's exit reaches the same kind of transfer as the handler
    //    copy's own non-rethrow exit: case A leaves the copy's transfer where
    //    it is, case B replaces it with the finalizer's.
    if (form.handlerIsRethrowOnly) {
      if (c.to >= ins.length) return { ok: false, reason: "a case-A finalizer copy swallowed its own control transfer" };
    } else if (c.to !== ins.length || ins[ins.length - 1]!.kind !== h[h.length - 1]!.kind) {
      return { ok: false, reason: "a case-B finalizer copy does not end in the same transfer as the finalizer" };
    }
    // 4. Nothing the printer drops is still needed at the copy site.
    for (let i = c.from; i < c.to; i++) {
      if (c.retained?.includes(i) === true) continue;
      for (const w of writtenRegisters(ins[i]!)) {
        for (let j = c.to; j < ins.length; j++) {
          if (ins[j]!.operands.some((op, k) => op.role === "reg" && op.value === w && !(k === 0 && writtenRegisters(ins[j]!).includes(w)))) {
            return { ok: false, reason: "a dropped finalizer-copy instruction defines a register the exit still reads" };
          }
          if (writtenRegisters(ins[j]!).includes(w)) break;
        }
      }
    }
  }
  return { ok: true };
}
