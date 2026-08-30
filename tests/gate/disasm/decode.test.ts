// docs/specs/02-disassembler.md §3, §9 — instruction decoder: spot-checks,
// validation, probe-aware error hints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { decodeFunction, decodeModule, tryDecodeFunction } from "../../../src/disasm/decode.ts";
import { getOpcodeTable } from "../../../src/tables/registry.ts";
import { fixture, listFixtures } from "../../support/fixtures.ts";
import { isKnownAmbiguousV98 } from "../../support/known-issues.ts";

function bin(group: string, name: string, version: number, variant: "" | "public" = "") {
  const f = fixture(group, name);
  const b = f.binaries.find((x) => x.version === version && x.variant === variant);
  if (b === undefined) throw new Error(`no v${version}${variant} binary for ${group}/${name}`);
  return b;
}

test("§9 v94 spot-check: hermes-dec-sample function 0", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const fn = decodeFunction(mod, 0);
  const rendered = fn.instructions.slice(0, 7).map((i) => `${i.name} ${i.operands.map((o) => o.value).join(",")}`);
  assert.deepEqual(rendered, [
    "DeclareGlobalVar 17",
    "DeclareGlobalVar 19",
    "DeclareGlobalVar 25",
    "CreateEnvironment 1",
    "CreateAsyncClosure 2,1,1",
    "GetGlobalObject 0",
    "PutById 0,2,1,17",
  ]);
  assert.equal(mod.strings.get(17), "testx");
  assert.equal(mod.strings.get(19), "gen");
  assert.equal(mod.strings.get(25), "ze");
  assert.equal(fn.instructions[3]!.operands[0]!.role, "reg");
  assert.equal(fn.instructions[4]!.operands[2]!.role, "function");
  assert.equal(fn.instructions[6]!.operands[2]!.role, "cacheIndex");
  assert.equal(fn.instructions[6]!.operands[3]!.role, "string");
});

test("§9 v99 spot-check: hermes-dec-sample-public function 0", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 99, "public").bytes());
  const fn = decodeFunction(mod, 0);
  const rendered = fn.instructions.slice(0, 7).map((i) => `${i.name} ${i.operands.map((o) => o.value).join(",")}`);
  assert.deepEqual(rendered, [
    "CreateFunctionEnvironment 3,0",
    "DeclareGlobalVar 16",
    "DeclareGlobalVar 19",
    "DeclareGlobalVar 34",
    "GetGlobalObject 2",
    "CreateClosure 4,3,1",
    "PutByIdLoose 2,4,0,16",
  ]);
  assert.equal(mod.strings.get(16), "testx");
});

test("§9: v98/v99 opcode-table cross-decode of the switch fixture must fail", () => {
  // hermes-dec-sample's function 0 is too simple to discriminate: none of its
  // early opcodes happen to fall in the v98/v99-divergent range (spec 01
  // §5.2.1's "agree on every opcode below 165"), so it decodes "successfully"
  // (silently wrong) under either table — exactly the failure mode spec 02
  // §3.3's probe-aware hint exists for, not a counterexample to this bullet.
  // `52-switch-jumptable` is the fixture spec 02 §9 actually describes: its
  // `UIntSwitchImm`/switch opcode is 0xa6 (166) at v98 and 0xa7 (167) at v99 —
  // under the wrong table, byte 0xa6 decodes as `CreateRegExp` (4 operands, 13
  // bytes) instead of `UIntSwitchImm` (5 operands, 17 bytes), which runs the
  // decode off the rails immediately.
  const v98 = parseHbc(bin("constructs", "52-switch-jumptable", 98).bytes());
  const v99 = parseHbc(bin("constructs", "52-switch-jumptable", 99).bytes());
  const classifyFnIndex98 = v98.functions.findIndex((f) => f.name === "classify");
  const classifyFnIndex99 = v99.functions.findIndex((f) => f.name === "classify");
  assert.ok(classifyFnIndex98 >= 0 && classifyFnIndex99 >= 0);

  const r1 = tryDecodeFunction(v98, classifyFnIndex98, getOpcodeTable("hbc99-mar2026"));
  assert.equal(r1.ok, false, "v98's switch function must fail to decode under the v99 table");

  const r2 = tryDecodeFunction(v99, classifyFnIndex99, getOpcodeTable("hbc98-late"));
  assert.equal(r2.ok, false, "v99's switch function must fail to decode under the v98 table");
});

test("§9: v99 fixture decoded with hbc99-feb2026 fails within the first 16 bytes of function 0", () => {
  const v99 = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 99, "public").bytes());
  const feb = getOpcodeTable("hbc99-feb2026");
  const r = tryDecodeFunction(v99, 0, feb);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.offset - v99.functions[0]!.header.offset < 16, `expected failure within 16 bytes, got offset ${r.offset}`);
});

test("§9: v98/v99 CreateRegExp differs by exactly one opcode byte (0xa5 vs 0xa6) and both decode to CreateRegExp", () => {
  const v98 = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 98).bytes());
  const v99 = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 99, "public").bytes());
  const fn98 = v98.functions[0]!;
  const fn99 = v99.functions[0]!;
  const body98 = fn98.body();
  const body99 = fn99.body();
  assert.equal(body98[81], 0xa5);
  assert.equal(body99[81], 0xa6);
  const decoded98 = decodeFunction(v98, 0);
  const decoded99 = decodeFunction(v99, 0);
  const insn98 = decoded98.instructions.find((i) => i.offset === 81)!;
  const insn99 = decoded99.instructions.find((i) => i.offset === 81)!;
  assert.equal(insn98.name, "CreateRegExp");
  assert.equal(insn99.name, "CreateRegExp");
});

test("decodeModule yields one DecodedFunction per index, lazily, in order", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const indices: number[] = [];
  for (const fn of decodeModule(mod)) indices.push(fn.index);
  assert.deepEqual(
    indices,
    mod.functions.map((_, i) => i),
  );
});

test("decodeModule honours opts.indices as a subset", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const got = [...decodeModule(mod, { indices: [2, 0] })].map((f) => f.index);
  assert.deepEqual(got, [2, 0]);
});

test("E_BAD_FUNCTION_ID for an out-of-range function index", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  assert.throws(() => decodeFunction(mod, mod.functions.length + 10), /E_BAD_FUNCTION_ID/);
});

test("every gate binary decodes every function with zero errors, ip lands exactly on bytecodeSizeInBytes", () => {
  const fixtures = listFixtures();
  let total = 0;
  for (const f of fixtures) {
    for (const b of f.binaries) {
      // D8: force the externally-validated table on the 8 fixtures where the
      // auto-probe correctly refuses to guess (tests/support/known-issues.ts).
      const forceTable = isKnownAmbiguousV98(f.group, f.name, b.version) ? "hbc98-late" : undefined;
      const mod = parseHbc(b.bytes(), forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
      for (const fn of decodeModule(mod)) {
        total++;
        const last = fn.instructions[fn.instructions.length - 1];
        if (last !== undefined) {
          assert.equal(last.offset + last.length, fn.header.bytecodeSizeInBytes, `${f.group}/${f.name} v${b.version} fn#${fn.index}: decode did not land exactly on bytecodeSizeInBytes`);
        }
      }
    }
  }
  assert.ok(total > 0);
});

test("every jump target in every gate binary resolves to an instruction boundary inside its function", () => {
  const fixtures = listFixtures();
  for (const f of fixtures) {
    for (const b of f.binaries) {
      const forceTable = isKnownAmbiguousV98(f.group, f.name, b.version) ? "hbc98-late" : undefined;
      const mod = parseHbc(b.bytes(), forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
      for (const fn of decodeModule(mod)) {
        for (const insn of fn.instructions) {
          for (const t of insn.targets) {
            assert.ok(fn.byOffset.has(t), `${f.group}/${f.name} v${b.version} fn#${fn.index}: ${insn.name}@${insn.offset} target ${t} not an instruction start`);
          }
        }
      }
    }
  }
});

test("operand role: GetById-family cacheIndex byte is consumed but role-tagged, not treated as an id", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const fn = decodeFunction(mod, 0);
  const getById = fn.instructions.find((i) => i.name === "GetByIdShort")!;
  const cacheOperand = getById.operands[2]!;
  assert.equal(cacheOperand.role, "cacheIndex");
  assert.equal(cacheOperand.type, "UInt8");
});

test("operand role: CreateRegExp's 4th operand is 'regexp', not 'imm'", () => {
  const mod = parseHbc(bin("constructs", "45-regex-literals", 94).bytes());
  let found = false;
  for (const fn of decodeModule(mod)) {
    for (const insn of fn.instructions) {
      if (insn.name === "CreateRegExp") {
        found = true;
        assert.equal(insn.operands[0]!.role, "reg");
        assert.equal(insn.operands[1]!.role, "string");
        assert.equal(insn.operands[2]!.role, "string");
        assert.equal(insn.operands[3]!.role, "regexp");
      }
    }
  }
  assert.ok(found, "no CreateRegExp found in 45-regex-literals v94");
});

test("operand role: CallBuiltin/GetBuiltinClosure's builtin number is role 'builtin'", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  let found = false;
  for (const fn of decodeModule(mod)) {
    for (const insn of fn.instructions) {
      if (insn.name === "GetBuiltinClosure") {
        found = true;
        assert.equal(insn.operands[1]!.role, "builtin");
      }
    }
  }
  assert.ok(found, "no GetBuiltinClosure found in hermes-dec-sample v94");
});
