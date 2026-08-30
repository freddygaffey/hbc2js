import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryReader } from "../../../src/util/reader.ts";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";

function bytesOf(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

test("BinaryReader reads little-endian primitives", () => {
  const r = new BinaryReader(bytesOf(0x01, 0x02, 0x03, 0x04, 0xff, 0x00));
  assert.equal(r.u8(), 0x01);
  assert.equal(r.u16(), (0x03 << 8) | 0x02);
  assert.equal(r.u8(), 0x04);
});

test("BinaryReader.u32 is little-endian", () => {
  const r = new BinaryReader(bytesOf(0x78, 0x56, 0x34, 0x12));
  assert.equal(r.u32(), 0x12345678);
});

test("BinaryReader.i32 sign-extends", () => {
  const r = new BinaryReader(bytesOf(0xff, 0xff, 0xff, 0xff));
  assert.equal(r.i32(), -1);
});

test("BinaryReader.f64 reads IEEE-754 double little-endian", () => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, 7.3, true);
  const r = new BinaryReader(new Uint8Array(buf));
  assert.equal(r.f64(), 7.3);
});

test("BinaryReader throws Hbc2jsError E_SECTION_OVERRUN, never a raw RangeError", () => {
  const r = new BinaryReader(bytesOf(0x01));
  assert.throws(() => r.u32(), (e: unknown) => e instanceof Hbc2jsError && (e as Hbc2jsError).code === ErrorCode.E_SECTION_OVERRUN);
});

test("BinaryReader.bytes returns a view, not a copy", () => {
  const src = bytesOf(1, 2, 3, 4);
  const r = new BinaryReader(src);
  const view = r.bytes(2);
  assert.equal(view.buffer, src.buffer);
  view[0] = 99;
  assert.equal(src[0], 99);
});

test("BinaryReader.align advances to the next multiple", () => {
  const r = new BinaryReader(new Uint8Array(16));
  r.skip(3);
  r.align(4);
  assert.equal(r.offset, 4);
  r.align(4);
  assert.equal(r.offset, 4);
});

test("BinaryReader.seek and peekU32 do not move the cursor", () => {
  const r = new BinaryReader(bytesOf(0, 0, 0, 0, 0x2a, 0, 0, 0));
  assert.equal(r.peekU32(4), 0x2a);
  assert.equal(r.offset, 0);
  r.seek(4);
  assert.equal(r.u32(), 0x2a);
});
