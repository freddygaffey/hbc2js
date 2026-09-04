// docs/BUGS.md 2026-08-31 — `--split` on react-navigation-example produced
// `E_EMIT_UNSUPPORTED: slot 1 of r3 has no known object shape at offset 186`
// for fn#8640. The emitter tracked object-literal shapes in a single mutable
// register→keys map advanced in *statement emission order*: the `if` arm
// emitted first clobbered r3 (`LoadFromEnvironment r3, r2, 2`), so the
// `PutOwnBySlotIdx r3, …, 1` in the arm emitted second found no shape at all,
// even though the creating `NewObjectWithBuffer` dominates both arms.
//
// `src/emit/shapes.ts` replaces that with a forward must-analysis over the CFG
// (docs/specs/05-emitter.md §"Object shapes"). These are the properties the
// analysis owes the emitter; the bundle-level regression for the actual fn#8640
// is `tests/sweep/emit/shape-across-blocks.test.ts` (that fixture is fetched,
// not committed, so it cannot live in the gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Instruction } from "../../../src/disasm/decode.ts";
import type { BasicBlock, FunctionCfg } from "../../../src/cfg/types.ts";
import { resolveShapesWith } from "../../../src/emit/shapes.ts";

const SHAPE_A: readonly string[] = Object.freeze(["inputRange", "outputRange", "extrapolate"]);
const SHAPE_B: readonly string[] = Object.freeze(["left", "right"]);

/** A synthetic instruction: `name` plus register operands, at `offset`. */
function insn(offset: number, name: string, ...regs: readonly number[]): Instruction {
  return {
    offset,
    length: 1,
    opcode: 0,
    name,
    operands: regs.map((value) => ({ type: "Reg8", role: "reg", value })),
    kind: "normal",
    targets: [],
    fallsThrough: true,
  } as unknown as Instruction;
}

/** `NewObjectWithBuffer rD` standing for shape `which` (the fake creation table
 *  below turns the second operand into one of the two interned shapes). */
const newObj = (offset: number, dest: number, which: 0 | 1): Instruction => insn(offset, "NewObjectWithBuffer", dest, which);
const putSlot = (offset: number, obj: number, value: number): Instruction => insn(offset, "PutOwnBySlotIdx", obj, value, 0);
const getSlot = (offset: number, dest: number, obj: number): Instruction => insn(offset, "GetOwnBySlotIdx", dest, obj, 0);

function block(id: number, instructions: readonly Instruction[], succs: readonly number[], opts: { handler?: boolean } = {}): BasicBlock {
  return {
    id,
    start: id * 1000,
    end: id * 1000 + 999,
    instructions,
    terminator: { kind: succs.length === 0 ? "return" : "jump" },
    succs: succs.map((to) => ({ from: id, to, kind: "normal" })),
    preds: [],
    isHandlerEntry: opts.handler === true,
  } as unknown as BasicBlock;
}

function cfgOf(blocks: readonly BasicBlock[]): FunctionCfg {
  return { functionIndex: 0, blocks, entry: 0, exits: [] } as unknown as FunctionCfg;
}

/** The injected creation table: operand 1 of a `NewObjectWithBuffer` picks the
 *  shape, mirroring the real v>=97 shape-table index. */
const created = (i: Instruction): readonly string[] | null => (i.name === "NewObjectWithBuffer" ? (i.operands[1]!.value === 0 ? SHAPE_A : SHAPE_B) : null);

void test("a shape created before a branch resolves in BOTH arms, even when the arm emitted first clobbers the register (fn#8640)", () => {
  // b0: r3 = {…}; r3.slot0 = …; if (c)
  // b1: r3.slot1 = …; r3 = <env slot>   (the arm the old emission-order map ran first)
  // b2: r3.slot1 = …                     (the arm that used to fail: offset 186)
  const shapes = resolveShapesWith(
    created,
    cfgOf([
      block(0, [newObj(10, 3, 0), putSlot(20, 3, 8)], [1, 2]),
      block(1, [putSlot(30, 3, 6), insn(40, "LoadFromEnvironment", 3, 2, 2)], []),
      block(2, [putSlot(186, 3, 6)], []),
    ]),
  );
  assert.deepEqual(shapes.get(20), SHAPE_A);
  assert.deepEqual(shapes.get(30), SHAPE_A);
  assert.deepEqual(shapes.get(186), SHAPE_A, "the read in the second arm lost its shape — emission order is leaking into the analysis again");
});

void test("paths that disagree about the shape resolve to nothing (no guessed key)", () => {
  const shapes = resolveShapesWith(
    created,
    cfgOf([
      block(0, [], [1, 2]),
      block(1, [newObj(10, 5, 0)], [3]),
      block(2, [newObj(20, 5, 1)], [3]),
      block(3, [getSlot(30, 1, 5)], []),
    ]),
  );
  assert.equal(shapes.get(30), undefined);
});

void test("paths that agree about the shape resolve to it", () => {
  const shapes = resolveShapesWith(
    created,
    cfgOf([
      block(0, [], [1, 2]),
      block(1, [newObj(10, 5, 1)], [3]),
      block(2, [newObj(20, 5, 1)], [3]),
      block(3, [getSlot(30, 1, 5)], []),
    ]),
  );
  assert.deepEqual(shapes.get(30), SHAPE_B);
});

void test("a loop back edge cannot invent a shape that only holds on later iterations", () => {
  // b1 reads r2 at the TOP of the body; r2 is only created at the BOTTOM, so
  // the first iteration reaches the read with no shape. A must-analysis has to
  // say "unknown" even though the back edge carries a shape.
  const shapes = resolveShapesWith(
    created,
    cfgOf([
      block(0, [], [1]),
      block(1, [getSlot(10, 4, 2), newObj(20, 2, 0), getSlot(30, 4, 2)], [1, 2]),
      block(2, [], []),
    ]),
  );
  assert.equal(shapes.get(10), undefined, "the back edge's shape leaked into the loop entry");
  assert.deepEqual(shapes.get(30), SHAPE_A);
});

void test("an exception-handler entry starts with nothing known (a throw can land there from anywhere)", () => {
  const shapes = resolveShapesWith(
    created,
    cfgOf([
      block(0, [newObj(10, 3, 0)], [1]),
      block(1, [getSlot(20, 4, 3)], [], { handler: true }),
    ]),
  );
  assert.equal(shapes.get(20), undefined);
});

void test("Mov carries the shape (the same object, so the same hidden class); an unrelated write drops it", () => {
  const shapes = resolveShapesWith(
    created,
    cfgOf([block(0, [newObj(10, 1, 0), insn(20, "Mov", 2, 1), getSlot(30, 5, 2), insn(40, "GetById", 2, 9, 0, 0), getSlot(50, 5, 2)], [])]),
  );
  assert.deepEqual(shapes.get(30), SHAPE_A);
  assert.equal(shapes.get(50), undefined);
});

void test("a block unreachable through normal edges resolves nothing rather than everything", () => {
  const shapes = resolveShapesWith(created, cfgOf([block(0, [newObj(10, 3, 0)], []), block(1, [getSlot(20, 4, 3)], [])]));
  assert.equal(shapes.get(20), undefined);
});
