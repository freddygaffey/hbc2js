// Hand-built CFGs with real-looking instructions, for pass unit tests on
// hand-built trees (spec 07 §9 items 1–3). Mirrors structure.test.ts's synthCfg
// but lets each block carry instructions, which the loop passes read.
import { computeDominators } from "../../../src/cfg/dom.ts";
import type { BasicBlock, BlockId, Edge, FunctionCfg, FunctionKindInfo } from "../../../src/cfg/types.ts";
import type { Instruction, InstrKind, Operand } from "../../../src/disasm/decode.ts";

export const reg = (value: number): Operand => ({ type: "Reg8", role: "reg", value });
export const imm = (value: number): Operand => ({ type: "UInt8", role: "imm", value });
export const addr = (value: number): Operand => ({ type: "Addr8", role: "addr", value });

let nextOffset = 0;
/** `kind`/`targets`/`fallsThrough` are derived from the name the way the real decoder does. */
export function insn(name: string, ...operands: Operand[]): Instruction {
  const offset = nextOffset;
  nextOffset += 4;
  const rel = operands.find((o) => o.role === "addr")?.value;
  const kind: InstrKind = name === "Ret" ? "return" : name === "Throw" ? "throw" : name === "Catch" ? "catch" : rel === undefined ? "normal" : name === "Jmp" || name === "JmpLong" ? "jump" : "condJump";
  return {
    offset,
    length: 4,
    opcode: 0,
    name,
    operands,
    kind,
    targets: rel === undefined || kind === "normal" ? [] : [offset + rel],
    fallsThrough: kind === "normal" || kind === "condJump",
  };
}

export interface SynthBlock {
  readonly succs: readonly BlockId[];
  readonly insns: readonly Instruction[];
}

export function synthCfg(spec: readonly SynthBlock[]): FunctionCfg {
  const blocks: BasicBlock[] = spec.map(({ succs: targets, insns }, id) => {
    const edges: Edge[] = targets.map((to, k) => ({ from: id, to, kind: targets.length === 1 ? "jump" : k === 0 ? "branch-taken" : "branch-not-taken" }) as Edge);
    return {
      id,
      start: insns[0]?.offset ?? id * 16,
      end: (insns[insns.length - 1]?.offset ?? id * 16) + 4,
      instructions: insns,
      terminator: targets.length === 0 ? { kind: "return" } : targets.length === 1 ? { kind: "jump" } : { kind: "branch" },
      succs: edges,
      preds: [],
      isHandlerEntry: false,
    } as BasicBlock;
  });
  const preds: BlockId[][] = blocks.map(() => []);
  for (const b of blocks) for (const e of b.succs) if (!preds[e.to]!.includes(e.from)) preds[e.to]!.push(e.from);
  for (const [i, b] of blocks.entries()) (b as { preds: readonly BlockId[] }).preds = preds[i]!.sort((a, z) => a - z);
  const { rpo, dom, reducible } = computeDominators(blocks, 0, 0);
  const kind: FunctionKindInfo = { functionIndex: 0, kind: "normal", era: "none", evidence: [], innerFunctionIndex: null, trampolineFunctionIndex: null, shimRequired: false };
  return {
    functionIndex: 0,
    blocks,
    entry: 0,
    exits: blocks.filter((b) => b.succs.length === 0).map((b) => b.id),
    byOffset: new Map(blocks.map((b) => [b.start, b.id])),
    exceptionSuccs: new Map(),
    regions: [],
    switchTables: [],
    dom,
    rpo,
    reducible,
    generator: { info: kind, resumeDispatch: null, suspendPoints: [], generatorOps: [] },
    frameSize: 4,
    paramCount: 1,
    diagnostics: [],
  };
}

/**
 * `r1 = 0; r2 = 10; do { r1++ } while (r1 < r2); return` — the rotated loop
 * hermesc emits for `for (let i = 0; i < 10; i++) {}` once the constant
 * pre-test is folded (docs/lowering/for-loop.md).
 */
export function countingLoop(): FunctionCfg {
  return synthCfg([
    { succs: [1], insns: [insn("LoadConstZero", reg(1)), insn("LoadConstUInt8", reg(2), imm(10))] },
    { succs: [1, 2], insns: [insn("Inc", reg(1), reg(1)), insn("JLess", addr(-4), reg(1), reg(2))] },
    { succs: [], insns: [insn("Ret", reg(1))] },
  ]);
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
