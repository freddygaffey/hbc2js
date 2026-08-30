// docs/specs/01-parser.md §5.5 — table self-verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getBuiltinTable, getOpcodeTable, listOpcodeTableIds, verifyTables } from "../../../src/tables/registry.ts";
import { ALL_OPCODE_TABLE_IDS } from "../../../src/tables/types.ts";

test("verifyTables passes for every generated table (idempotent)", () => {
  assert.doesNotThrow(() => verifyTables());
  assert.doesNotThrow(() => verifyTables());
});

test("listOpcodeTableIds returns all 7 pinned tables", () => {
  assert.deepEqual(listOpcodeTableIds(), ALL_OPCODE_TABLE_IDS);
});

test("opcode counts match spec 01 §5.5 / §9 exactly", () => {
  const expected: Record<string, number> = {
    hbc84: 185,
    hbc94: 192,
    hbc96: 192,
    "hbc98-2024": 201,
    "hbc98-late": 219,
    "hbc99-feb2026": 219,
    "hbc99-mar2026": 220,
  };
  for (const [id, count] of Object.entries(expected)) {
    assert.equal(getOpcodeTable(id as never).opcodes.length, count, id);
  }
});

test("every table's opcodes[0] is Unreachable and numbering is positional", () => {
  for (const id of listOpcodeTableIds()) {
    const t = getOpcodeTable(id);
    assert.equal(t.opcodes[0]?.name, "Unreachable");
    for (let i = 0; i < t.opcodes.length; i++) assert.equal(t.opcodes[i]?.n, i);
  }
});

test("hbc94 spot-checks (docs/specs/01-parser.md §5.5)", () => {
  const t = getOpcodeTable("hbc94");
  const byName = new Map(t.opcodes.map((o) => [o.name, o.n]));
  assert.equal(byName.get("DeclareGlobalVar"), 52);
  assert.equal(byName.get("GetGlobalObject"), 48);
  assert.equal(byName.get("CreateEnvironment"), 50);
  assert.equal(byName.get("PutById"), 59);
  assert.equal(byName.get("CreateAsyncClosure"), 104);
  assert.equal(byName.get("Ret"), 92);
  assert.equal(byName.get("Catch"), 93);
  assert.equal(byName.get("CreateRegExp"), 132);
  assert.equal(byName.get("SwitchImm"), 133);
  assert.equal(getBuiltinTable("hbc94").builtins.find((b) => b.name === "spawnAsync")?.n, 52);
});

test("hbc99-mar2026 spot-checks including the NewTypedObjectWithBuffer insertion", () => {
  const t = getOpcodeTable("hbc99-mar2026");
  const byName = new Map(t.opcodes.map((o) => [o.name, o.n]));
  assert.equal(byName.get("GetParentEnvironment"), 52);
  assert.equal(byName.get("GetGlobalObject"), 61);
  assert.equal(byName.get("CreateFunctionEnvironment"), 64);
  assert.equal(byName.get("CreateTopLevelEnvironment"), 65);
  assert.equal(byName.get("DeclareGlobalVar"), 67);
  assert.equal(byName.get("GetByIdShort"), 68);
  assert.equal(byName.get("TryGetById"), 72);
  assert.equal(byName.get("PutByIdLoose"), 74);
  assert.equal(byName.get("Ret"), 118);
  assert.equal(byName.get("Catch"), 119);
  assert.equal(byName.get("CreateClosure"), 132);
  assert.equal(byName.get("CreateRegExp"), 166);
  assert.equal(byName.get("UIntSwitchImm"), 167);
  assert.equal(byName.get("StringSwitchImm"), 168);
  assert.equal(byName.get("CreateGenerator"), 169);
  assert.equal(byName.get("NewTypedObjectWithBuffer"), 4);
});

test("hbc98-late spot-checks (empirically patched table)", () => {
  const t = getOpcodeTable("hbc98-late");
  const byName = new Map(t.opcodes.map((o) => [o.name, o.n]));
  assert.equal(byName.get("CreateFunctionEnvironment"), 64);
  assert.equal(byName.get("DeclareGlobalVar"), 67);
  assert.equal(byName.get("GetGlobalObject"), 61);
  assert.equal(byName.get("PutByIdLoose"), 74);
  assert.equal(byName.get("CreateClosure"), 132);
  assert.equal(byName.get("CreateRegExp"), 165);
  assert.equal(byName.get("UIntSwitchImm"), 166);
  assert.equal(byName.get("StringSwitchImm"), 167);
  assert.equal(byName.has("NewTypedObjectWithBuffer"), false);
});

test("hbc96 spot-checks: identical to hbc94 except DirectEval gains a UInt8 operand", () => {
  const t94 = getOpcodeTable("hbc94");
  const t96 = getOpcodeTable("hbc96");
  assert.equal(t94.opcodes.length, t96.opcodes.length);
  for (let i = 0; i < t94.opcodes.length; i++) {
    const a = t94.opcodes[i]!;
    const b = t96.opcodes[i]!;
    assert.equal(a.name, b.name, `opcode ${i} name`);
    if (a.name === "DirectEval") {
      assert.deepEqual(a.operands, ["Reg8", "Reg8"]);
      assert.deepEqual(b.operands, ["Reg8", "Reg8", "UInt8"]);
    } else {
      assert.deepEqual(a.operands, b.operands, `opcode ${i} (${a.name}) operands`);
    }
  }
});

test("PROVENANCE.md records hbc94=1c717488 and hbc84=c2cd9e38 as resolved in spec 01 §5.2", () => {
  const t84 = getOpcodeTable("hbc84");
  const t94 = getOpcodeTable("hbc94");
  assert.ok(t84.hermesCommit.startsWith("c2cd9e38"));
  assert.ok(t94.hermesCommit.startsWith("1c717488"));
});
