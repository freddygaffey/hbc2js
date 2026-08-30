// docs/specs/03-cfg.md §4 — leader computation, basic blocks, normal edges.
// No recursion over graph data anywhere in this file (§8 rule 1).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Instruction, SwitchTable } from "../disasm/decode.ts";
import type { ExceptionHandler } from "../parse/types.ts";
import type { BasicBlock, BlockId, BlockTerminator, Edge } from "./types.ts";

// `SaveGenerator` decodes as a conditional jump (exactly one Addr operand, see
// src/disasm/decode.ts's classify()), but it is not one: it records a resume pc
// and falls through. Spec 03 §4.2 is explicit — "a `SaveGenerator; Ret` block
// terminates in `return` and therefore has no successor"; its resume block is
// entered from the §4.5 dispatcher, never from here. Letting it produce a
// branch edge would make the resume blocks reachable *twice* and would silently
// disarm CFG-05's generator carve-out.
const SAVE_GENERATOR: ReadonlySet<string> = new Set(["SaveGenerator", "SaveGeneratorLong"]);

/** §4.1 — the leader set. Rules 1–7, in the spec's order. */
export function computeLeaders(instructions: readonly Instruction[], handlers: readonly ExceptionHandler[], bytecodeSize: number, byOffset: ReadonlyMap<number, number>): number[] {
  const leaders = new Set<number>();
  leaders.add(0); // rule 1 (also covers the zero-byte body case; see buildBlocks)

  for (const insn of instructions) {
    // rules 2 + 3: every jump / switch-case / switch-default target
    for (const t of insn.targets) leaders.add(t);
    // rule 4: the instruction after every terminator (SaveGenerator excluded — it
    // is not a terminator, see the note above)
    if ((!insn.fallsThrough || insn.kind === "condJump") && !SAVE_GENERATOR.has(insn.name)) {
      const next = insn.offset + insn.length;
      if (next < bytecodeSize) leaders.add(next);
    }
    // rule 7: v<=96 generators — the target of every SaveGenerator. `targets`
    // already carries it (SaveGenerator decodes as a condJump: exactly one Addr
    // operand, see src/disasm/decode.ts's classify()), so rule 2 covers it; the
    // explicit restatement here is why rule 7 exists as its own bullet.
  }

  // rules 5 + 6: every handler target, start and end. Rule 6 is what makes the
  // regions block-aligned; skipping it breaks CFG-09.
  for (const h of handlers) {
    if (byOffset.has(h.target)) leaders.add(h.target);
    if (byOffset.has(h.start)) leaders.add(h.start);
    if (h.end < bytecodeSize && byOffset.has(h.end)) leaders.add(h.end);
  }

  return [...leaders].sort((a, b) => a - b);
}

function terminatorFor(last: Instruction): BlockTerminator {
  if (SAVE_GENERATOR.has(last.name)) return { kind: "fallthrough" };
  switch (last.kind) {
    case "jump":
      return { kind: "jump" };
    case "condJump":
      return { kind: "branch" };
    case "switch":
      return { kind: "switch", table: last.switchTable! };
    case "return":
      return { kind: "return" };
    case "throw":
      return { kind: "throw" };
    case "unreachable":
      return { kind: "unreachable" };
    default:
      return { kind: "fallthrough" };
  }
}

export interface RawBlocks {
  readonly blocks: BasicBlock[];
  readonly byOffset: Map<number, BlockId>;
}

/** §4.1/§4.2 — split the instruction stream at the leaders and wire normal edges. */
export function buildBlocks(instructions: readonly Instruction[], leaders: readonly number[], bytecodeSize: number, functionIndex: number, handlers: readonly ExceptionHandler[]): RawBlocks {
  const byOffset = new Map<number, BlockId>();
  for (const [i, off] of leaders.entries()) byOffset.set(off, i);

  const handlerTargets = new Set(handlers.map((h) => h.target));

  // Slice instructions into blocks. One linear pass; instructions are already
  // in ascending offset order (spec 02 decodes sequentially).
  const slices: Instruction[][] = leaders.map(() => []);
  let cur = -1;
  for (const insn of instructions) {
    const at = byOffset.get(insn.offset);
    if (at !== undefined) cur = at;
    if (cur < 0) {
      throw new Hbc2jsError(ErrorCode.E_INTERNAL, `instruction at ${insn.offset} precedes the first leader`, { functionIndex, offset: insn.offset, section: "cfg/blocks" });
    }
    slices[cur]!.push(insn);
  }

  const blocks: BasicBlock[] = [];
  for (const [id, start] of leaders.entries()) {
    const body = slices[id]!;
    if (body.length === 0) {
      // A zero-byte function body is real: hermesc emits `size=0` placeholder
      // entries that share another function's offset (observed on
      // 01-if-else-chain/v99.obf.hbc function #6). Model it as one empty block
      // that returns; anything else is an internal error.
      if (bytecodeSize !== 0 || leaders.length !== 1) {
        throw new Hbc2jsError(ErrorCode.E_INTERNAL, `block ${id} at offset ${start} is empty`, { functionIndex, offset: start, section: "cfg/blocks" });
      }
      blocks.push({ id, start: 0, end: 0, instructions: [], terminator: { kind: "return" }, succs: [], preds: [], isHandlerEntry: false });
      continue;
    }
    const last = body[body.length - 1]!;
    const end = last.offset + last.length;
    const term = terminatorFor(last);
    const succs: Edge[] = [];

    const to = (offset: number, kind: Edge["kind"], caseValue?: number, caseIsString?: boolean): Edge => {
      const target = byOffset.get(offset);
      if (target === undefined) {
        throw new Hbc2jsError(ErrorCode.E_JUMP_MISALIGNED, `edge target ${offset} is not a block start`, { functionIndex, offset, section: "cfg/blocks" });
      }
      return {
        from: id,
        to: target,
        kind,
        ...(caseValue !== undefined ? { caseValue } : {}),
        ...(caseIsString !== undefined ? { caseIsString } : {}),
      };
    };

    switch (term.kind) {
      case "jump":
        succs.push(to(last.targets[0]!, "jump"));
        break;
      case "branch":
        succs.push(to(last.targets[0]!, "branch-taken"));
        if (end < bytecodeSize) succs.push(to(end, "branch-not-taken"));
        break;
      case "switch": {
        const table: SwitchTable = term.table;
        for (const c of table.cases) succs.push(to(c.target, "switch-case", c.value, table.kind === "string"));
        succs.push(to(table.defaultTarget, "switch-default"));
        break;
      }
      case "return":
      case "throw":
      case "unreachable":
        break;
      case "fallthrough":
        if (end < bytecodeSize) succs.push(to(end, "fallthrough"));
        break;
      // (a fallthrough block at the end of the function is re-tagged below)
    }

    // A block that would fall through past `bytecodeSizeInBytes` is a dead tail:
    // hermesc ends such a block with a never-returning call (v>=97 generator
    // bodies end with `CallBuiltin throwTypeError`). CFG-06 requires every
    // non-exit block to have a successor, so tag it `unreachable` — which the
    // emitter renders as a `throw`, never as a silent fallthrough (EM-08).
    const finalTerm: BlockTerminator = term.kind === "fallthrough" && succs.length === 0 ? { kind: "unreachable" } : term;

    const isHandlerEntry = handlerTargets.has(start);
    const first = body[0]!;
    const catchRegister = isHandlerEntry && first.name === "Catch" ? first.operands[0]!.value : undefined;

    blocks.push({
      id,
      start,
      end,
      instructions: body,
      terminator: finalTerm,
      succs,
      preds: [],
      isHandlerEntry,
      ...(catchRegister !== undefined ? { catchRegister } : {}),
    });
  }

  return { blocks, byOffset };
}

/** CFG-04 — `preds` is exactly the reverse of all `succs`, deduplicated. */
export function computePreds(blocks: BasicBlock[]): void {
  const preds: Set<BlockId>[] = blocks.map(() => new Set<BlockId>());
  for (const b of blocks) for (const e of b.succs) preds[e.to]!.add(e.from);
  for (const [i, b] of blocks.entries()) {
    (b as { preds: readonly BlockId[] }).preds = [...preds[i]!].sort((a, z) => a - z);
  }
}
