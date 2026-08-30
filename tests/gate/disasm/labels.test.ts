// docs/specs/02-disassembler.md §5 — deterministic labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignHandlerLabels, assignLabels } from "../../../src/disasm/labels.ts";
import type { Instruction } from "../../../src/disasm/decode.ts";

function insn(offset: number, targets: readonly number[]): Instruction {
  return { offset, length: 1, opcode: 0, name: "Test", operands: [], kind: targets.length > 0 ? "condJump" : "normal", targets, fallsThrough: true };
}

test("labels are assigned L1, L2, ... in ascending offset order, L0 unused", () => {
  const instructions = [insn(0, [50]), insn(10, [20]), insn(20, []), insn(50, [])];
  const labels = assignLabels(instructions, []);
  assert.deepEqual([...labels.entries()].sort((a, b) => a[0] - b[0]), [
    [20, "L1"],
    [50, "L2"],
  ]);
  assert.ok(![...labels.values()].includes("L0"));
});

test("handler targets fold into the L namespace; start/end get a separate T namespace", () => {
  const instructions = [insn(0, [30])];
  const handlers = [{ start: 5, end: 15, target: 30 }];
  const labels = assignLabels(instructions, handlers);
  assert.equal(labels.get(30), "L1");
  assert.equal(labels.has(5), false);
  assert.equal(labels.has(15), false);

  const handlerLabels = assignHandlerLabels(handlers);
  assert.equal(handlerLabels.get(5), "T1");
  assert.equal(handlerLabels.get(15), "T2");
});

test("a handler start/end that happens to coincide with a jump target gets both an L and a T label", () => {
  const instructions = [insn(0, [15])];
  const handlers = [{ start: 5, end: 15, target: 40 }];
  const labels = assignLabels(instructions, handlers);
  const handlerLabels = assignHandlerLabels(handlers);
  assert.equal(labels.get(15), "L1");
  assert.equal(handlerLabels.get(15), "T2");
});

test("multiple handlers get ascending T-namespace labels independent of L numbering", () => {
  const handlers = [
    { start: 30, end: 50, target: 52 },
    { start: 30, end: 71, target: 73 },
    { start: 75, end: 149, target: 151 },
  ];
  const handlerLabels = assignHandlerLabels(handlers);
  assert.deepEqual(
    [...handlerLabels.entries()].sort((a, b) => a[0] - b[0]),
    [
      [30, "T1"],
      [50, "T2"],
      [71, "T3"],
      [75, "T4"],
      [149, "T5"],
    ],
  );
});

test("labels are deterministic across repeated calls", () => {
  const instructions = [insn(0, [10]), insn(10, [0])];
  const a = assignLabels(instructions, []);
  const b = assignLabels(instructions, []);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});
