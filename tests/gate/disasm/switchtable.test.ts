// docs/specs/02-disassembler.md §4 — switch jump tables. The worked example is
// this milestone's primary unit test for the alignment/extent traps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { decodeFunction, decodeModule } from "../../../src/disasm/decode.ts";
import { fixture } from "../../support/fixtures.ts";

function bin(group: string, name: string, version: number) {
  const f = fixture(group, name);
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`no v${version} binary for ${group}/${name}`);
  return b;
}

test("§4.1 worked example: constructs/52-switch-jumptable v94 'classify'", () => {
  const mod = parseHbc(bin("constructs", "52-switch-jumptable", 94).bytes());
  const idx = mod.functions.findIndex((f) => f.name === "classify");
  assert.ok(idx >= 0);
  const fn = decodeFunction(mod, idx);
  assert.equal(fn.header.offset, 0x204);
  assert.equal(fn.header.bytecodeSizeInBytes, 260);

  const insn = fn.instructions.find((i) => i.name === "SwitchImm")!;
  assert.equal(insn.offset, 7);
  const st = insn.switchTable!;
  assert.equal(st.kind, "uint");
  assert.equal(st.tableOffset, 260); // tableRel
  assert.equal(st.min, 0);
  assert.equal(st.max, 12);
  assert.equal(st.cases.length, 13);
  assert.equal(st.defaultTarget, 230); // 7 + 223
  assert.equal(fn.extentEnd, 312);

  const rawCases = [207, 191, 191, 161, 175, 145, 129, 113, 94, 75, 56, 37, 18];
  const targets = st.cases.map((c) => c.target);
  assert.deepEqual(
    targets,
    rawCases.map((r) => 7 + r),
  );
  assert.equal(st.cases[1]!.target, st.cases[2]!.target, "cases 1 and 2 share a target (fall-through)");
  for (const t of targets) assert.ok(fn.byOffset.has(t), `target ${t} must be an instruction start`);
});

test("§4.3: constructs/52-switch-jumptable / 53-switch-jumptable-large decode at v84/v94/v98/v99", () => {
  for (const name of ["52-switch-jumptable", "53-switch-jumptable-large"]) {
    for (const version of [84, 94, 98, 99]) {
      const f = fixture("constructs", name);
      const b = f.binaries.find((x) => x.version === version && x.variant === "");
      if (b === undefined) continue; // some (fixture, version) combinations don't compile
      const mod = parseHbc(b.bytes());
      let sawSwitch = false;
      for (const fn of decodeModule(mod)) {
        for (const insn of fn.instructions) {
          if (insn.kind === "switch") {
            sawSwitch = true;
            assert.ok(insn.switchTable !== undefined);
            assert.equal(insn.switchTable!.cases.length > 0, true);
          }
        }
      }
      assert.ok(sawSwitch, `${name} v${version}: expected at least one switch instruction`);
    }
  }
});

test("uint switch: max < min is rejected", async () => {
  const { decodeUintSwitch } = await import("../../../src/disasm/switchtable.ts");
  assert.throws(
    () =>
      decodeUintSwitch({
        bytes: new Uint8Array(1024),
        fileLength: 1024,
        functionOffset: 0,
        bytecodeSize: 100,
        insnOffset: 0,
        functionIndex: 0,
        tableOffset: 20,
        defaultTarget: 5,
        min: 5,
        max: 2,
      }),
    /E_SWITCH_TABLE/,
  );
});

test("uint switch: a case target out of [0, bytecodeSize) is rejected", async () => {
  const { decodeUintSwitch } = await import("../../../src/disasm/switchtable.ts");
  const bytes = new Uint8Array(1024);
  const view = new DataView(bytes.buffer);
  // table at aligned offset; one entry, way out of range.
  view.setInt32(20, 100000, true);
  assert.throws(
    () =>
      decodeUintSwitch({
        bytes,
        fileLength: 1024,
        functionOffset: 0,
        bytecodeSize: 100,
        insnOffset: 0,
        functionIndex: 0,
        tableOffset: 20,
        defaultTarget: 5,
        min: 0,
        max: 0,
      }),
    /E_SWITCH_TABLE/,
  );
});

test("uint switch: absolute-address alignment — tableOffset makes the absolute address land on a non-4-aligned byte without the function-offset correction", async () => {
  const { decodeUintSwitch } = await import("../../../src/disasm/switchtable.ts");
  // functionOffset itself is NOT 4-aligned (5). ip=0, tableOffset=3 => raw
  // function-relative math would say offset 3 is "aligned" (nothing to align,
  // 3 isn't a multiple of 4 either way) — the point is the *absolute* address
  // 5+0+3=8 is what actually gets aligned (already aligned, 8), whereas a
  // naive function-relative alignUp(0+3)=4 would read from absolute 5+4=9,
  // one byte off. Encode a valid int32 case entry at absolute 8 and confirm it
  // is read from there, not from 9.
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setInt32(8, 42, true); // case 0 raw displacement
  const st = decodeUintSwitch({
    bytes,
    fileLength: 64,
    functionOffset: 5,
    bytecodeSize: 60,
    insnOffset: 0,
    functionIndex: 0,
    tableOffset: 3,
    defaultTarget: 1,
    min: 0,
    max: 0,
  });
  assert.equal(st.tableOffset, 3); // tableAbs(8) - functionOffset(5)
  assert.equal(st.cases[0]!.target, 42); // insnOffset(0) + raw(42)
});

test("string switch: caseLabelStringID out of range is rejected", async () => {
  const { decodeStringSwitch } = await import("../../../src/disasm/switchtable.ts");
  const bytes = new Uint8Array(1024);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, 999, true); // string id way over stringCount
  view.setInt32(24, 5, true);
  assert.throws(
    () =>
      decodeStringSwitch({
        bytes,
        fileLength: 1024,
        functionOffset: 0,
        bytecodeSize: 100,
        insnOffset: 0,
        functionIndex: 0,
        tableOffset: 20,
        defaultTarget: 5,
        tableSize: 1,
        stringCount: 10,
      }),
    /E_BAD_STRING_ID/,
  );
});

test("switch: case count over the sanity ceiling is rejected", async () => {
  const { decodeUintSwitch } = await import("../../../src/disasm/switchtable.ts");
  assert.throws(
    () =>
      decodeUintSwitch({
        bytes: new Uint8Array(16),
        fileLength: 16,
        functionOffset: 0,
        bytecodeSize: 100,
        insnOffset: 0,
        functionIndex: 0,
        tableOffset: 4,
        defaultTarget: 0,
        min: 0,
        max: 1 << 21,
      }),
    /E_SWITCH_TABLE/,
  );
});
