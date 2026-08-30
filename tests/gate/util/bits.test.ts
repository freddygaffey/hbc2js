import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBits } from "../../../src/util/bits.ts";

test("extractBits pulls LSB-first bitfields out of a 32-bit word", () => {
  // word = paramCount(7 bits, value 3) << 25 | offset(25 bits, value 100)
  const word = (3 << 25) | 100;
  assert.equal(extractBits(word, 0, 25), 100);
  assert.equal(extractBits(word, 25, 7), 3);
});

test("extractBits handles a full 32-bit width", () => {
  assert.equal(extractBits(0xffffffff, 0, 32), 0xffffffff);
});

test("extractBits rejects invalid width/offset combinations", () => {
  assert.throws(() => extractBits(0, 0, 0), RangeError);
  assert.throws(() => extractBits(0, 0, 33), RangeError);
  assert.throws(() => extractBits(0, 30, 5), RangeError);
});
