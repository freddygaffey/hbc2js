// QUEUE (e2e round-trip register/scheduling insensitivity) — unit tests for
// `normaliseFunction`'s `{ strong: true }` mode (src/harness/roundtrip.ts),
// against hand-built decoder output rather than compiled bytecode: cheap,
// deterministic, and exercises exactly the normalisation rules (docs/e2e/
// RESULTS.md's `diff:LoadConstUndefined/GetGlobalObject`, `diff:LoadParam
// (imm)` buckets) without needing a hermesc oracle.
//
// Every "still DIFFERENT" case here proves the rules stay within D3: they
// never merge two functions whose dataflow actually differs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseFunction } from "../../../src/harness/roundtrip.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import type { DecodedFunction, Instruction, Operand } from "../../../src/disasm/decode.ts";

function fakeModule(strings: readonly string[] = []): HbcModule {
  return {
    layout: { builtinTable: undefined },
    strings: { get: (n: number) => strings[n] ?? `s${n}` },
    functions: [],
    shapes: [],
    bigInts: [],
  } as unknown as HbcModule;
}

function reg(n: number): Operand {
  return { type: "Reg8", role: "reg", value: n };
}
function imm(n: number): Operand {
  return { type: "UInt8", role: "imm", value: n };
}
function str(n: number): Operand {
  return { type: "UInt16", role: "string", value: n };
}

function insn(offset: number, name: string, operands: readonly Operand[], extra: Partial<Instruction> = {}): Instruction {
  return { offset, length: 1, opcode: 0, name, operands, kind: "normal", targets: [], fallsThrough: true, ...extra } as Instruction;
}

function fakeFn(name: string, paramCount: number, instructions: readonly Instruction[]): DecodedFunction {
  const byOffset = new Map(instructions.map((i, idx) => [i.offset, idx]));
  return {
    index: 0,
    header: { paramCount },
    name,
    instructions,
    byOffset,
    labels: new Map<number, string>(),
    handlers: [],
    switchTables: [],
    extentEnd: 0,
    diagnostics: [],
  } as unknown as DecodedFunction;
}

test("strong normalisation: register-permuted functions still normalise equal (unchanged from the always-on renaming)", () => {
  const mod = fakeModule();
  const a = fakeFn("f", 1, [insn(0, "LoadParam", [reg(1), imm(1)]), insn(2, "Mov", [reg(2), reg(1)]), insn(4, "Ret", [reg(2)], { kind: "return" })]);
  const b = fakeFn("f", 1, [insn(0, "LoadParam", [reg(9), imm(1)]), insn(2, "Mov", [reg(3), reg(9)]), insn(4, "Ret", [reg(3)], { kind: "return" })]);
  assert.equal(normaliseFunction(mod, a), normaliseFunction(mod, b));
  assert.equal(normaliseFunction(mod, a, { strong: true }), normaliseFunction(mod, b, { strong: true }));
});

test("strong normalisation: reordered independent loads normalise equal, weak normalisation does not", () => {
  const mod = fakeModule();
  // A: LoadConstZero, LoadParam, GetGlobalObject, then a real use of the
  // first two so their registers matter to the rename.
  const a = fakeFn("f", 2, [
    insn(0, "LoadConstZero", [reg(0)]),
    insn(1, "LoadParam", [reg(1), imm(1)]),
    insn(3, "GetGlobalObject", [reg(2)]),
    insn(4, "Add", [reg(3), reg(0), reg(1)]),
    insn(7, "Ret", [reg(3)], { kind: "return" }),
  ]);
  // B: same three loads in a different order and different physical
  // registers — provably the same program (the loads read nothing and
  // write distinct registers), just scheduled differently.
  const b = fakeFn("f", 2, [
    insn(0, "GetGlobalObject", [reg(9)]),
    insn(1, "LoadConstZero", [reg(5)]),
    insn(2, "LoadParam", [reg(6), imm(1)]),
    insn(4, "Add", [reg(8), reg(5), reg(6)]),
    insn(7, "Ret", [reg(8)], { kind: "return" }),
  ]);
  assert.notEqual(normaliseFunction(mod, a), normaliseFunction(mod, b), "weak normalisation is order-sensitive by design");
  assert.equal(normaliseFunction(mod, a, { strong: true }), normaliseFunction(mod, b, { strong: true }));
});

test("strong normalisation: LoadConstZero and LoadConstUInt8 0 render identically; LoadConstUInt8 1 does not", () => {
  const mod = fakeModule();
  const zero = fakeFn("f", 0, [insn(0, "LoadConstZero", [reg(0)]), insn(1, "Ret", [reg(0)], { kind: "return" })]);
  const uint8Zero = fakeFn("f", 0, [insn(0, "LoadConstUInt8", [reg(0), imm(0)]), insn(2, "Ret", [reg(0)], { kind: "return" })]);
  const uint8One = fakeFn("f", 0, [insn(0, "LoadConstUInt8", [reg(0), imm(1)]), insn(2, "Ret", [reg(0)], { kind: "return" })]);
  assert.equal(normaliseFunction(mod, zero, { strong: true }), normaliseFunction(mod, uint8Zero, { strong: true }));
  assert.notEqual(normaliseFunction(mod, zero, { strong: true }), normaliseFunction(mod, uint8One, { strong: true }));
  // Weak mode never conflates the two opcodes at all.
  assert.notEqual(normaliseFunction(mod, zero), normaliseFunction(mod, uint8Zero));
});

test("strong normalisation: a real semantic difference (different constant string) stays DIFFERENT", () => {
  const mod = fakeModule(["foo", "bar"]);
  const a = fakeFn("f", 0, [insn(0, "LoadConstString", [reg(0), str(0)]), insn(2, "Ret", [reg(0)], { kind: "return" })]);
  const b = fakeFn("f", 0, [insn(0, "LoadConstString", [reg(0), str(1)]), insn(2, "Ret", [reg(0)], { kind: "return" })]);
  assert.notEqual(normaliseFunction(mod, a, { strong: true }), normaliseFunction(mod, b, { strong: true }));
});

test("strong normalisation: an extra call in the middle stays DIFFERENT (not swallowed by reordering)", () => {
  const mod = fakeModule();
  const a = fakeFn("f", 0, [insn(0, "LoadConstZero", [reg(0)]), insn(1, "GetGlobalObject", [reg(1)]), insn(2, "Ret", [reg(0)], { kind: "return" })]);
  const b = fakeFn("f", 0, [
    insn(0, "LoadConstZero", [reg(0)]),
    insn(1, "Call", [reg(2), reg(1), imm(0)]),
    insn(4, "GetGlobalObject", [reg(1)]),
    insn(5, "Ret", [reg(0)], { kind: "return" }),
  ]);
  assert.notEqual(normaliseFunction(mod, a, { strong: true }), normaliseFunction(mod, b, { strong: true }));
});

test("strong normalisation: a duplicate-destination run (dead store) is left in original order, not reordered", () => {
  const mod = fakeModule();
  // Two writes to the same register r0 inside what would otherwise be a
  // poolable run: reordering them would change which value survives, so the
  // run must be left exactly as decoded.
  const a = fakeFn("f", 0, [insn(0, "LoadConstZero", [reg(0)]), insn(1, "LoadConstUInt8", [reg(0), imm(5)]), insn(3, "Ret", [reg(0)], { kind: "return" })]);
  const out = normaliseFunction(mod, a, { strong: true });
  const lines = out.split("\n");
  assert.match(lines[1]!, /val#0$/, "first line is still the zero load");
  assert.match(lines[2]!, /val#5$/, "second line is still the 5 load, in original order");
});

test("strong normalisation: a labelled (jump-target) instruction blocks reordering across it", () => {
  const mod = fakeModule();
  const insns: Instruction[] = [insn(0, "LoadConstZero", [reg(0)]), insn(1, "GetGlobalObject", [reg(1)]), insn(2, "Ret", [reg(1)], { kind: "return" })];
  const fn: DecodedFunction = {
    index: 0,
    header: { paramCount: 0 },
    name: "f",
    instructions: insns,
    byOffset: new Map(insns.map((i, idx) => [i.offset, idx])),
    labels: new Map([[1, "L0"]]), // GetGlobalObject is a jump target
    handlers: [],
    switchTables: [],
    extentEnd: 0,
    diagnostics: [],
  } as unknown as DecodedFunction;
  const out = normaliseFunction(mod, fn, { strong: true });
  // With a label on the second instruction, the two loads are not a
  // reorderable "run" of length > 1 spanning it — order stays as decoded.
  assert.equal(out.split("\n")[1], "LoadConst %0, val#0");
  assert.equal(out.split("\n")[2], "L0: GetGlobalObject %1");
});
