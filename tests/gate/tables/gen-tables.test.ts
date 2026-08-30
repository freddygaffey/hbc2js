// docs/specs/01-parser.md §5.4, §9 — macro-aware .def parser rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBuiltinsDef, parseBytecodeListDef, stripComments } from "../../../tools/gen-tables/parse-def.ts";
import { repoRoot } from "../../support/paths.ts";

test("stripComments removes // and block comments while preserving line count", () => {
  const src = "a\n// comment\nb /* inline */ c\n/* multi\nline */\nd\n";
  const stripped = stripComments(src);
  assert.equal(stripped.split("\n").length, src.split("\n").length);
  assert.ok(!stripped.includes("comment"));
  assert.ok(!stripped.includes("inline"));
  assert.ok(!stripped.includes("multi"));
});

test("real hbc94 BytecodeList.def yields exactly 192 opcodes, Unreachable first, independent count agrees", () => {
  const text = readFileSync(join(repoRoot(), "third_party", "hermes", "hbc94", "BytecodeList.def"), "utf8");
  const parsed = parseBytecodeListDef(text);
  assert.equal(parsed.opcodes.length, 192);
  assert.equal(parsed.independentCount, 192);
  assert.equal(parsed.opcodes[0]?.name, "Unreachable");
});

test("every pinned .def yields the expected opcode count (§9 acceptance)", () => {
  const expected: Record<string, number> = {
    hbc84: 185,
    hbc94: 192,
    hbc96: 192,
    "hbc98-2024": 201,
    "hbc98-late": 219, // vendored (unpatched) count; the generator patches this one further
    "hbc99-feb2026": 219,
    "hbc99-mar2026": 220,
  };
  for (const [id, count] of Object.entries(expected)) {
    const text = readFileSync(join(repoRoot(), "third_party", "hermes", id, "BytecodeList.def"), "utf8");
    const parsed = parseBytecodeListDef(text);
    assert.equal(parsed.opcodes.length, count, `${id} opcode count`);
    assert.equal(parsed.independentCount, count, `${id} independent count`);
  }
});

test("DEFINE_JUMP_n synthesises two adjacent opcodes, short (Addr8) first", () => {
  const synthetic = `
    DEFINE_OPERAND_TYPE(Reg8, uint8_t)
    DEFINE_OPERAND_TYPE(Addr8, int8_t)
    DEFINE_OPERAND_TYPE(Addr32, int32_t)
    DEFINE_OPERAND_TYPE(UInt8, uint8_t)
    DEFINE_OPERAND_TYPE(UInt16, uint16_t)
    DEFINE_OPERAND_TYPE(UInt32, uint32_t)
    DEFINE_OPERAND_TYPE(Reg32, uint32_t)
    DEFINE_OPERAND_TYPE(Imm32, int32_t)
    DEFINE_OPERAND_TYPE(Double, double)
    DEFINE_OPCODE_0(Unreachable)
    DEFINE_JUMP_2(JmpTrue)
  `;
  const parsed = parseBytecodeListDef(synthetic);
  assert.equal(parsed.opcodes.length, 3);
  assert.deepEqual(parsed.opcodes[1], { n: 1, name: "JmpTrue", operands: ["Addr8", "Reg8"] });
  assert.deepEqual(parsed.opcodes[2], { n: 2, name: "JmpTrueLong", operands: ["Addr32", "Reg8"] });
});

test("macro-body skipping survives a renamed placeholder (name0 instead of name)", () => {
  // §5.4 rule 0's loud-reject check must not be the only thing preventing a
  // differently-named placeholder from leaking through as a real opcode — the
  // structural (line/#if/continuation) skip must do it regardless of the name used.
  const synthetic = `
    #ifndef DEFINE_OPERAND_TYPE
    #define DEFINE_OPERAND_TYPE(...)
    #endif
    #ifndef DEFINE_OPCODE_0
    #define DEFINE_OPCODE_0(name0) DEFINE_OPCODE(name0)
    #endif
    #ifndef DEFINE_OPCODE_1
    #define DEFINE_OPCODE_1(name0, ...) DEFINE_OPCODE(name0)
    #endif
    #ifndef DEFINE_OPCODE
    #define DEFINE_OPCODE(...)
    #endif
    DEFINE_OPERAND_TYPE(Reg8, uint8_t)
    DEFINE_OPERAND_TYPE(Reg32, uint32_t)
    DEFINE_OPERAND_TYPE(UInt8, uint8_t)
    DEFINE_OPERAND_TYPE(UInt16, uint16_t)
    DEFINE_OPERAND_TYPE(UInt32, uint32_t)
    DEFINE_OPERAND_TYPE(Addr8, int8_t)
    DEFINE_OPERAND_TYPE(Addr32, int32_t)
    DEFINE_OPERAND_TYPE(Imm32, int32_t)
    DEFINE_OPERAND_TYPE(Double, double)
    DEFINE_OPCODE_0(Unreachable)
    DEFINE_OPCODE_1(Mov, Reg8)
  `;
  const parsed = parseBytecodeListDef(synthetic);
  assert.equal(parsed.opcodes.length, 2);
  assert.equal(parsed.opcodes[0]?.name, "Unreachable");
  assert.equal(parsed.opcodes[1]?.name, "Mov");
  assert.equal(parsed.independentCount, 2);
});

test("content inside #ifdef HERMES_RUN_WASM is excluded from the count", () => {
  const synthetic = `
    DEFINE_OPERAND_TYPE(Reg8, uint8_t)
    DEFINE_OPERAND_TYPE(Reg32, uint32_t)
    DEFINE_OPERAND_TYPE(UInt8, uint8_t)
    DEFINE_OPERAND_TYPE(UInt16, uint16_t)
    DEFINE_OPERAND_TYPE(UInt32, uint32_t)
    DEFINE_OPERAND_TYPE(Addr8, int8_t)
    DEFINE_OPERAND_TYPE(Addr32, int32_t)
    DEFINE_OPERAND_TYPE(Imm32, int32_t)
    DEFINE_OPERAND_TYPE(Double, double)
    DEFINE_OPCODE_0(Unreachable)
    #ifdef HERMES_RUN_WASM
    DEFINE_OPCODE_3(Add32, Reg8, Reg8, Reg8)
    #endif
    DEFINE_OPCODE_0(Ret)
  `;
  const parsed = parseBytecodeListDef(synthetic);
  assert.equal(parsed.opcodes.length, 2);
  assert.equal(parsed.opcodes.some((o) => o.name === "Add32"), false);
});

test("an unmodelled macro shape fails loudly rather than being silently ignored", () => {
  const synthetic = `
    DEFINE_OPERAND_TYPE(Reg8, uint8_t)
    DEFINE_OPCODE_0(Unreachable)
    SOME_UNKNOWN_MACRO(Foo, Bar)
  `;
  assert.throws(() => parseBytecodeListDef(synthetic), /unmodelled macro/);
});

test("parseBuiltinsDef: builtin numbers are positional across NORMAL_METHOD/BUILTIN_METHOD/PRIVATE_BUILTIN/JS_BUILTIN only", () => {
  const synthetic = `
    NORMAL_OBJECT(globalThis)
    NORMAL_METHOD(globalThis, Symbol)
    BUILTIN_OBJECT(Math)
    BUILTIN_METHOD(Math, abs)
    PRIVATE_BUILTIN(apply)
    MARK_FIRST_PRIVATE_BUILTIN(apply)
    JS_BUILTIN(spawnAsync)
  `;
  const builtins = parseBuiltinsDef(synthetic);
  assert.deepEqual(
    builtins.map((b) => b.name),
    ["globalThis.Symbol", "Math.abs", "apply", "spawnAsync"],
  );
  assert.equal(builtins.find((b) => b.name === "spawnAsync")?.n, 3);
});

test("real hbc94 Builtins.def: spawnAsync is builtin 52", () => {
  const text = readFileSync(join(repoRoot(), "third_party", "hermes", "hbc94", "Builtins.def"), "utf8");
  const builtins = parseBuiltinsDef(text);
  assert.equal(builtins.find((b) => b.name === "spawnAsync")?.n, 52);
});

test("real hbc99-mar2026 Builtins.def: spawnAsync is builtin 57", () => {
  const text = readFileSync(join(repoRoot(), "third_party", "hermes", "hbc99-mar2026", "Builtins.def"), "utf8");
  const builtins = parseBuiltinsDef(text);
  assert.equal(builtins.find((b) => b.name === "spawnAsync")?.n, 57);
});
