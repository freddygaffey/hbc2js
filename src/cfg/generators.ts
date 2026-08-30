// docs/specs/03-cfg.md §3.4, §3.4.1, §4.5 — generator/async classification and
// the v<=96 synthetic resume-dispatch entry block.
//
// The two-hop rule of §3.4.1 is written out rather than described because
// reading the creation-site operand as "the body" silently finds a 3-instruction
// trampoline with zero SaveGenerators.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { DecodedFunction, Instruction } from "../disasm/decode.ts";
import type { SwitchTable } from "../disasm/switchtable.ts";
import type { HbcModule } from "../parse/types.ts";
import type { BasicBlock, BlockId, Edge, FunctionKind, FunctionKindInfo, GeneratorEra, SuspendPoint } from "./types.ts";

const GENERATOR_CLOSURE_OPS = new Set(["CreateGeneratorClosure", "CreateGeneratorClosureLongIndex"]);
const ASYNC_CLOSURE_OPS = new Set(["CreateAsyncClosure", "CreateAsyncClosureLongIndex"]);
const CREATE_GENERATOR_OPS = new Set(["CreateGenerator", "CreateGeneratorLongIndex"]);
const PLAIN_CLOSURE_OPS = new Set(["CreateClosure", "CreateClosureLongIndex"]);
export const SAVE_GENERATOR_OPS = new Set(["SaveGenerator", "SaveGeneratorLong"]);
const GENERATOR_OP_NAMES = new Set(["StartGenerator", "CompleteGenerator", "ResumeGenerator", "SaveGenerator", "SaveGeneratorLong"]);

/** True for a module whose generators are compiler-lowered state machines (v>=97). */
export function loweredEra(mod: HbcModule): boolean {
  return mod.header.version >= 97;
}

function functionOperand(insn: Instruction): number {
  const op = insn.operands.find((o) => o.role === "function");
  if (op === undefined) {
    throw new Hbc2jsError(ErrorCode.E_INTERNAL, `${insn.name} at ${insn.offset} has no function-id operand`, { offset: insn.offset, section: "cfg/generators" });
  }
  return op.value;
}

interface Mutable {
  functionIndex: number;
  kind: FunctionKind;
  era: GeneratorEra;
  evidence: ("header" | "creation-site" | "body")[];
  innerFunctionIndex: number | null;
  trampolineFunctionIndex: number | null;
  shimRequired: boolean;
}

/** §3.4 / §3.4.1 — whole-module classification. `decode` is memoised by the caller. */
export function classifyFunctions(mod: HbcModule, decode: (i: number) => DecodedFunction): readonly FunctionKindInfo[] {
  const lowered = loweredEra(mod);
  const info: Mutable[] = mod.functions.map((_, i) => ({
    functionIndex: i,
    kind: "normal",
    era: "none",
    evidence: [],
    innerFunctionIndex: null,
    trampolineFunctionIndex: null,
    shimRequired: false,
  }));

  const bodies = new Map<number, DecodedFunction | null>();
  const body = (i: number): DecodedFunction | null => {
    const hit = bodies.get(i);
    if (hit !== undefined) return hit;
    let value: DecodedFunction | null;
    try {
      value = decode(i);
    } catch {
      value = null;
    }
    bodies.set(i, value);
    return value;
  };

  const addEvidence = (m: Mutable, e: "header" | "creation-site" | "body"): void => {
    if (!m.evidence.includes(e)) m.evidence.push(e);
  };

  // Step 1 — find creation sites.
  interface Site {
    readonly target: number;
    readonly kind: FunctionKind;
  }
  const sites: Site[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = body(i);
    if (fn === null) continue;
    for (const insn of fn.instructions) {
      if (!lowered && GENERATOR_CLOSURE_OPS.has(insn.name)) sites.push({ target: functionOperand(insn), kind: "generator" });
      else if (!lowered && ASYNC_CLOSURE_OPS.has(insn.name)) sites.push({ target: functionOperand(insn), kind: "async" });
      else if (lowered && PLAIN_CLOSURE_OPS.has(insn.name)) {
        const f = functionOperand(insn);
        const hdr = mod.functions[f]?.header.flags;
        if (hdr === undefined || !hdr.kindKnown) continue;
        if (hdr.kind === "Generator") sites.push({ target: f, kind: "generator" });
        else if (hdr.kind === "Async") sites.push({ target: f, kind: "async" });
      }
    }
  }

  // v>=97: a header-kind Generator/Async function is one even without a visible
  // creation site (an orphan, or one created by CreateGenerator directly).
  if (lowered) {
    for (let i = 0; i < mod.functions.length; i++) {
      const flags = mod.functions[i]!.header.flags;
      if (!flags.kindKnown) continue;
      if (flags.kind === "Generator") sites.push({ target: i, kind: "generator" });
      else if (flags.kind === "Async") sites.push({ target: i, kind: "async" });
    }
  }

  const seen = new Set<number>();
  for (const site of sites) {
    const key = site.target * 4 + (site.kind === "generator" ? 1 : 2);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = site.target;
    const m = info[f];
    if (m === undefined) continue;
    m.kind = site.kind;
    m.era = lowered ? "lowered" : "opcode";
    addEvidence(m, lowered ? "header" : "creation-site");

    // Step 2 — the two-hop.
    const fBody = body(f);
    const createGen = fBody?.instructions.find((x) => CREATE_GENERATOR_OPS.has(x.name));
    if (createGen !== undefined) {
      m.trampolineFunctionIndex = f;
      m.innerFunctionIndex = functionOperand(createGen);
    } else {
      m.trampolineFunctionIndex = null;
      m.innerFunctionIndex = f;
    }

    // Step 3 — shimRequired on innerFunctionIndex, at BOTH eras.
    const innerInfo = info[m.innerFunctionIndex!];
    if (innerInfo !== undefined) {
      innerInfo.shimRequired = true;
      if (innerInfo.functionIndex !== f) {
        innerInfo.kind = site.kind;
        innerInfo.era = lowered ? "lowered" : "opcode";
      }
    }
  }

  // v<=96: a body that starts with StartGenerator is a generator body, whether
  // or not the creation site was reachable.
  if (!lowered) {
    for (let i = 0; i < mod.functions.length; i++) {
      const fn = body(i);
      if (fn === null) continue;
      if (fn.instructions[0]?.name !== "StartGenerator") continue;
      const m = info[i]!;
      if (m.kind === "normal") m.kind = "generator";
      m.era = "opcode";
      addEvidence(m, "body");
    }
  }

  return info.map((m) => ({
    functionIndex: m.functionIndex,
    kind: m.kind,
    era: m.era,
    evidence: [...m.evidence],
    innerFunctionIndex: m.innerFunctionIndex,
    trampolineFunctionIndex: m.trampolineFunctionIndex,
    shimRequired: m.shimRequired,
  }));
}

/** §3.4 — suspend points of one v<=96 generator/async body, in ascending saveOffset. */
export function findSuspendPoints(fn: DecodedFunction, byOffset: ReadonlyMap<number, BlockId>): SuspendPoint[] {
  const out: SuspendPoint[] = [];
  const instructions = fn.instructions;
  for (const [i, insn] of instructions.entries()) {
    if (!SAVE_GENERATOR_OPS.has(insn.name)) continue;
    const target = insn.targets[0];
    if (target === undefined) continue;
    const resumeBlock = byOffset.get(target);
    if (resumeBlock === undefined) {
      throw new Hbc2jsError(ErrorCode.E_JUMP_MISALIGNED, `${insn.name} at ${insn.offset} targets ${target}, which is not a block start (CFG-13)`, {
        functionIndex: fn.index,
        offset: insn.offset,
        section: "cfg/generators",
      });
    }
    const next = instructions[i + 1];
    const canonical = next !== undefined && next.name === "Ret";
    out.push({
      state: out.length + 1,
      saveOffset: insn.offset,
      resumeBlock,
      canonical,
      retRegister: canonical ? next!.operands[0]!.value : null,
    });
  }
  out.sort((a, b) => a.saveOffset - b.saveOffset);
  return out.map((s, i) => ({ ...s, state: i + 1 }));
}

export function findGeneratorOps(fn: DecodedFunction): { readonly offset: number; readonly name: string }[] {
  return fn.instructions.filter((i) => GENERATOR_OP_NAMES.has(i.name)).map((i) => ({ offset: i.offset, name: i.name }));
}

/**
 * §4.5 — prepend the synthetic resume-dispatch block and make it the entry.
 * Mutates `blocks` (they are still under construction at this point) and returns
 * the new entry id. Option (a) of the review: one graph, one tree, one proof.
 */
export function addResumeDispatch(blocks: BasicBlock[], realEntry: BlockId, suspendPoints: readonly SuspendPoint[]): BlockId {
  const id = blocks.length;
  const cases = [
    { value: 0, target: -1 },
    ...suspendPoints.map((s) => ({ value: s.state, target: -1 })),
  ];
  const table: SwitchTable = {
    kind: "uint",
    tableOffset: -1,
    byteLength: 0,
    defaultTarget: -1,
    min: 0,
    max: suspendPoints.length,
    cases,
  };
  const succs: Edge[] = [
    { from: id, to: realEntry, kind: "switch-case", caseValue: 0 },
    ...suspendPoints.map((s): Edge => ({ from: id, to: s.resumeBlock, kind: "switch-case", caseValue: s.state })),
    { from: id, to: realEntry, kind: "switch-default" },
  ];
  blocks.push({
    id,
    start: -1,
    end: -1,
    instructions: [],
    terminator: { kind: "switch", table, synthetic: true },
    succs,
    preds: [],
    isHandlerEntry: false,
  });
  return id;
}
