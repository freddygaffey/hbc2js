// Object-literal shape resolution (docs/specs/05-emitter.md §"Object shapes").
//
// `PutOwnBySlotIdx`/`GetOwnBySlotIdx` name a property by its *slot index* in the
// hidden class the object was created with, never by name, so the emitter has to
// recover the key list of the `NewObjectWithBuffer*` that created the object in
// the register the instruction reads.
//
// This used to be a single mutable register→keys map threaded through the
// emitter in *statement emission order*. That is not the order the VM executes
// blocks in: for an `if`/`else` whose two arms both write the same register, the
// arm emitted first clobbers the map, and the read in the arm emitted second
// then had no shape at all — react-navigation-example fn#8640 offset 0xba, the
// `E_EMIT_UNSUPPORTED` that aborted `--split` on the whole bundle
// (docs/BUGS.md 2026-08-31). Emission order also cannot express "the shape is
// the same on both paths to this read", which is the property that actually
// licenses printing a property name.
//
// So: a forward *must*-analysis over the real CFG, shaped like available
// expressions. A read resolves only when every path from the function entry to
// it agrees on one creation shape; otherwise it resolves to nothing and the
// caller raises `E_EMIT_UNSUPPORTED` with the register and slot. A key is never
// guessed (artifact truth, docs/DECISIONS.md).
import type { DecodedFunction, Instruction } from "../disasm/decode.ts";
import type { FunctionCfg } from "../cfg/types.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";
import type { HbcModule } from "../parse/types.ts";
import { objectKeys } from "./literals.ts";

/** Resolved keys per *reading* instruction offset (the `Put`/`GetOwnBySlotIdx`). */
export type ShapeMap = ReadonlyMap<number, readonly string[]>;

/**
 * Per-block register→keys state. Key arrays are interned per creation site
 * (§`internKeys`), so two states agree on a register exactly when the arrays are
 * reference-identical — which is what the meet below tests.
 */
type State = Map<number, readonly string[]>;

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

/** The register whose object shape this instruction reads, or `null`. */
export function shapeReadRegister(insn: Instruction): number | null {
  switch (insn.name) {
    case "PutOwnBySlotIdx":
    case "PutOwnBySlotIdxLong":
      return V(insn, 0);
    case "GetOwnBySlotIdx":
    case "GetOwnBySlotIdxLong":
      return V(insn, 1);
    default:
      return null;
  }
}

/**
 * The shape a `NewObjectWithBuffer*` gives its destination register, or `null`
 * when this instruction creates no shaped object. A malformed key buffer or an
 * out-of-range shape index answers `null` (unknown) rather than throwing: the
 * lowering of that same instruction raises the precise error, and this analysis
 * must not turn a decodable function into a crash in a *different* place.
 */
function createdShape(mod: HbcModule, fn: DecodedFunction, insn: Instruction, intern: (keys: readonly string[]) => readonly string[]): readonly string[] | null {
  let keyBufferOffset: number;
  let numProps: number;
  switch (insn.name) {
    case "NewObjectWithBuffer":
    case "NewObjectWithBufferLong": {
      if (insn.operands.length === 5) {
        // v<=96: (dest, sizeHint, numProps, keyBufferIdx, valueBufferIdx)
        keyBufferOffset = V(insn, 3);
        numProps = V(insn, 2);
        break;
      }
      // v>=97: (dest, shapeTableIdx, valueBufferOffset)
      const shape = mod.shapes[V(insn, 1)];
      if (shape === undefined) return null;
      keyBufferOffset = shape.keyBufferOffset;
      numProps = shape.numProps;
      break;
    }
    case "NewObjectWithBufferAndParent": {
      const shape = mod.shapes[V(insn, 2)];
      if (shape === undefined) return null;
      keyBufferOffset = shape.keyBufferOffset;
      numProps = shape.numProps;
      break;
    }
    default:
      return null;
  }
  try {
    return intern(objectKeys(mod, keyBufferOffset, numProps, fn.index, insn.offset));
  } catch {
    return null;
  }
}

/** `a ∧ b`: keep only the registers both states map to the *same* key array. */
function meet(a: State, b: State): State {
  const out: State = new Map();
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [reg, keys] of small) if (large.get(reg) === keys) out.set(reg, keys);
  return out;
}

function sameState(a: State, b: State): boolean {
  if (a.size !== b.size) return false;
  for (const [reg, keys] of a) if (b.get(reg) !== keys) return false;
  return true;
}

/**
 * Resolve every slot-indexed property read in `fn` that is resolvable.
 *
 * Lattice: a block's IN is the meet of its analysed predecessors' OUTs, with
 * the entry block starting empty and every other block starting at ⊤ ("not yet
 * reached"), iterated to a fixpoint — the standard must-analysis arrangement, so
 * a loop back edge cannot invent a shape that only holds on the first iteration.
 * Blocks still ⊤ at the fixpoint are unreachable through normal edges and are
 * finalised as empty (nothing known). Exception-handler entries are treated the
 * same way: a throw can land there from anywhere in the region, so nothing about
 * the register file is known on entry.
 *
 * Transfer: a `NewObjectWithBuffer*` sets its destination's shape; `Mov`/`MovLong`
 * copies the source's (the same object, so the same hidden class); any other
 * write to a register drops it.
 */
export function resolveShapes(mod: HbcModule, fn: DecodedFunction, cfg: FunctionCfg): ShapeMap {
  const interned = new Map<string, readonly string[]>();
  const intern = (keys: readonly string[]): readonly string[] => {
    const id = JSON.stringify(keys);
    const hit = interned.get(id);
    if (hit !== undefined) return hit;
    const frozen = Object.freeze([...keys]);
    interned.set(id, frozen);
    return frozen;
  };
  return resolveShapesWith((insn) => createdShape(mod, fn, insn, intern), cfg);
}

/**
 * `resolveShapes` with the "what shape does this instruction create" question
 * injected, so the dataflow itself can be tested without a parsed module
 * (`tests/gate/emit/shape-across-blocks.test.ts`). `shapeCreatedBy` must return
 * interned arrays: two creation sites agree exactly when they return the same
 * array reference.
 */
export function resolveShapesWith(shapeCreatedBy: (insn: Instruction) => readonly string[] | null, cfg: FunctionCfg): ShapeMap {
  const transfer = (state: State, insn: Instruction): void => {
    const created = shapeCreatedBy(insn);
    if (created !== null) {
      state.set(V(insn, 0), created);
      return;
    }
    if (insn.name === "Mov" || insn.name === "MovLong") {
      const src = state.get(V(insn, 1));
      if (src === undefined) state.delete(V(insn, 0));
      else state.set(V(insn, 0), src);
      return;
    }
    for (const r of writtenRegisters(insn)) state.delete(r);
  };

  const runBlock = (blockId: number, inState: State): State => {
    const state: State = new Map(inState);
    for (const insn of cfg.blocks[blockId]!.instructions) transfer(state, insn);
    return state;
  };

  // `undefined` === ⊤ (not yet reached).
  const inStates: (State | undefined)[] = new Array(cfg.blocks.length).fill(undefined);
  const outStates: (State | undefined)[] = new Array(cfg.blocks.length).fill(undefined);
  const handlerEntry = cfg.blocks.map((b) => b.isHandlerEntry);

  inStates[cfg.entry] = new Map();
  outStates[cfg.entry] = runBlock(cfg.entry, inStates[cfg.entry]!);
  const work: number[] = [cfg.entry];
  const queued = new Set<number>([cfg.entry]);
  // Bounded: every block can only be re-queued when its IN strictly shrinks, and
  // the state is finite, but keep a hard cap so a malformed CFG cannot spin.
  const cap = Math.max(1000, cfg.blocks.length * 8);
  let steps = 0;
  while (work.length > 0 && steps++ < cap) {
    const b = work.pop()!;
    queued.delete(b);
    for (const edge of cfg.blocks[b]!.succs) {
      const s = edge.to;
      const merged = handlerEntry[s] === true ? new Map<number, readonly string[]>() : inStates[s] === undefined ? new Map(outStates[b]!) : meet(inStates[s]!, outStates[b]!);
      if (inStates[s] !== undefined && sameState(inStates[s]!, merged)) continue;
      inStates[s] = merged;
      outStates[s] = runBlock(s, merged);
      if (!queued.has(s)) {
        queued.add(s);
        work.push(s);
      }
    }
  }

  // Final walk: record the resolved keys at each reading instruction.
  const out = new Map<number, readonly string[]>();
  for (const block of cfg.blocks) {
    const state: State = new Map(inStates[block.id] ?? []);
    for (const insn of block.instructions) {
      const readReg = shapeReadRegister(insn);
      if (readReg !== null) {
        const keys = state.get(readReg);
        if (keys !== undefined) out.set(insn.offset, keys);
      }
      transfer(state, insn);
    }
  }
  return out;
}
