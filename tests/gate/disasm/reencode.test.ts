// docs/specs/02-disassembler.md §7.E — re-encoding round-trip self-check. No
// oracle needed: for every decoded instruction, re-serialise its operand values
// using the table's widths and assert the bytes equal the function body's own
// bytes at that offset. Catches sign/width/endianness errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { decodeModule } from "../../../src/disasm/decode.ts";
import { getOpcodeTable } from "../../../src/tables/registry.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { isKnownAmbiguousV98 } from "../../support/known-issues.ts";

function encodeOperand(view: DataView, offset: number, type: string, value: number): void {
  switch (type) {
    case "Reg8":
    case "UInt8":
      view.setUint8(offset, value);
      return;
    case "UInt16":
      view.setUint16(offset, value, true);
      return;
    case "Reg32":
    case "UInt32":
      view.setUint32(offset, value, true);
      return;
    case "Addr8":
      view.setInt8(offset, value);
      return;
    case "Addr32":
    case "Imm32":
      view.setInt32(offset, value, true);
      return;
    case "Double":
      view.setFloat64(offset, value, true);
      return;
    default:
      throw new Error(`unknown operand type ${type}`);
  }
}

test("re-encode round-trip: every instruction of every gate binary is byte-exact", () => {
  const fixtures = listFixtures();
  let checked = 0;
  for (const f of fixtures) {
    for (const b of f.binaries) {
      // D8: the auto-probe correctly refuses to guess on these 8 fixtures
      // (hbc98-late vs hbc99-mar2026 genuinely disagree); force the table
      // external validation says is right rather than skipping them outright
      // (tests/support/known-issues.ts).
      const forceTable = isKnownAmbiguousV98(f.group, f.name, b.version) ? "hbc98-late" : undefined;
      const mod = parseHbc(b.bytes(), forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
      const table = mod.layout.opcodeTable !== undefined ? getOpcodeTable(mod.layout.opcodeTable) : undefined;
      if (table === undefined) continue;
      for (const fn of decodeModule(mod)) {
        const body = mod.functions[fn.index]!.body();
        for (const insn of fn.instructions) {
          const buf = new ArrayBuffer(insn.length);
          const view = new DataView(buf);
          const out = new Uint8Array(buf);
          out[0] = insn.opcode;
          let o = 1;
          const def = table.opcodes[insn.opcode]!;
          for (let i = 0; i < insn.operands.length; i++) {
            const type = def.operands[i]!;
            const width = table.operandTypes[type].bytes;
            encodeOperand(view, o, type, insn.operands[i]!.value);
            o += width;
          }
          const expected = body.subarray(insn.offset, insn.offset + insn.length);
          assert.deepEqual(Array.from(out), Array.from(expected), `${f.group}/${f.name} v${b.version} fn#${fn.index} @${insn.offset} (${insn.name}) re-encode mismatch`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000, `expected to check well over 1000 instructions, only checked ${checked}`);
});
