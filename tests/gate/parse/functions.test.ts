// docs/specs/01-parser.md §8 T2/T3 — function table + exception handlers + debug offsets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { fixture } from "../../support/fixtures.ts";

function bin(version: number, variant: "" | "public" = "") {
  const f = fixture("hermes-dec-sample", "hermes-dec-sample");
  const b = f.binaries.find((x) => x.version === version && x.variant === variant);
  if (b === undefined) throw new Error(`missing v${version}${variant}`);
  return b.bytes();
}

test("v94 function table, all 8 rows byte-exact", () => {
  const m = parseHbc(bin(94));
  const expected = [
    { offset: 0x320, params: 1, size: 235, nameId: 7, infoOffset: 0x5c8, frame: 16, env: 0, flags: 0x12 },
    { offset: 0x40b, params: 2, size: 30, nameId: 17, infoOffset: 0x5d4, frame: 15, env: 0, flags: 0x11 },
    { offset: 0x429, params: 2, size: 9, nameId: 2, infoOffset: 0x5e0, frame: 1, env: 0, flags: 0x01 },
    { offset: 0x432, params: 2, size: 124, nameId: 1, infoOffset: 0x5e0, frame: 16, env: 0, flags: 0x12 },
    { offset: 0x4ae, params: 1, size: 9, nameId: 19, infoOffset: 0x5ec, frame: 1, env: 0, flags: 0x01 },
    { offset: 0x4b7, params: 1, size: 179, nameId: 3, infoOffset: 0x5ec, frame: 17, env: 0, flags: 0x1a },
    { offset: 0x56a, params: 1, size: 54, nameId: 25, infoOffset: 0x620, frame: 12, env: 1, flags: 0x12 },
    { offset: 0x5a0, params: 1, size: 37, nameId: 9, infoOffset: 0x62c, frame: 9, env: 0, flags: 0x12 },
  ];
  assert.equal(m.functions.length, 8);
  for (let i = 0; i < 8; i++) {
    const f = m.functions[i]!;
    const e = expected[i]!;
    assert.equal(f.header.offset, e.offset, `fn${i}.offset`);
    assert.equal(f.header.paramCount, e.params, `fn${i}.paramCount`);
    assert.equal(f.header.bytecodeSizeInBytes, e.size, `fn${i}.size`);
    assert.equal(f.header.functionNameStringId, e.nameId, `fn${i}.nameId`);
    assert.equal(f.header.infoOffset, e.infoOffset, `fn${i}.infoOffset`);
    assert.equal(f.header.frameSize, e.frame, `fn${i}.frame`);
    assert.equal(f.header.environmentSize, e.env, `fn${i}.env`);
    assert.equal(f.header.flags.raw, e.flags, `fn${i}.flags`);
  }

  const names = m.functions.map((f) => f.name);
  assert.deepEqual(names, ["global", "testx", "?anon_0_testx", "?anon_0_?anon_0_testx", "gen", "?anon_0_gen", "ze", "zb"]);

  // functions 2 and 3 share infoOffset (legal, §3.4)
  assert.equal(m.functions[2]!.header.infoOffset, m.functions[3]!.header.infoOffset);

  // flag decoding
  assert.equal(m.functions[1]!.header.flags.prohibitInvoke, "construct");
  assert.equal(m.functions[1]!.header.flags.hasDebugInfo, true);
  assert.equal(m.functions[5]!.header.flags.hasExceptionHandler, true);
  assert.equal(m.functions[5]!.header.flags.hasDebugInfo, true);
  // Note: spec 01 §8 T2's prose says flags=0x1a implies "strict" too, but bit2 of
  // 0x1a is 0 under the documented (and, via the 0x11 case, independently
  // cross-checked) LSB-first layout -- prohibitInvoke:2, strictMode:1,
  // hasExceptionHandler:1, hasDebugInfo:1, overflowed:1. Asserting the two
  // verified bits only; see docs/AGENT-LOG.md.
  assert.equal(m.functions[5]!.header.flags.strictMode, false);

  // body() gives a zero-copy view of exactly bytecodeSizeInBytes bytes at offset.
  const body0 = m.functions[0]!.body();
  assert.equal(body0.length, 235);
  assert.equal(body0.buffer, m.bytes.buffer);
});

test("v94 fn5 exception handlers and debug offsets, byte-exact (§4.1)", () => {
  const m = parseHbc(bin(94));
  const fn5 = m.functions[5]!;
  assert.deepEqual(
    fn5.exceptionHandlers.map((h) => [h.start, h.end, h.target]),
    [
      [0x1e, 0x32, 0x34],
      [0x1e, 0x47, 0x49],
      [0x4b, 0x95, 0x97],
    ],
  );
  assert.equal(fn5.debugOffsets?.sourceLocations, 0x13c);
  assert.equal(fn5.debugOffsets?.scopeDescData, 0);
  assert.equal(fn5.debugOffsets?.textifiedCallees, 0);
});

test("v99 fn5 (the generator body): large header + 5 handlers + 4-byte DebugOffsets (§4.2)", () => {
  const m = parseHbc(bin(99));
  const fn5 = m.functions[5]!;
  assert.equal(fn5.header.offset, 0x4ef);
  assert.equal(fn5.header.paramCount, 1);
  assert.equal(fn5.header.loopDepth, 1);
  assert.equal(fn5.header.bytecodeSizeInBytes, 489);
  assert.equal(fn5.header.frameSize, 32);
  assert.equal(fn5.header.flags.hasExceptionHandler, true);
  assert.equal(fn5.header.flags.hasDebugInfo, true);
  assert.deepEqual(
    fn5.exceptionHandlers.map((h) => [h.start, h.end, h.target]),
    [
      [0x60, 0x116, 0x17b],
      [0x11e, 0x125, 0x17b],
      [0x131, 0x157, 0x17b],
      [0x15f, 0x166, 0x17b],
      [0x172, 0x17b, 0x17b],
    ],
  );
  // v99's DebugOffsets is 4 bytes: only sourceLocations, no scopeDescData/lexicalData.
  assert.equal(fn5.debugOffsets?.sourceLocations, 0x97);
  assert.equal(fn5.debugOffsets?.scopeDescData, null);
  assert.equal(fn5.debugOffsets?.lexicalData, null);
  assert.equal(m.layout.debugOffsetsSize, 4);
});

test("v99 function table: fn2 and fn4 are non-overflowed generator stubs, fn0's large header is exact", () => {
  const m = parseHbc(bin(99));
  const fn2 = m.functions[2]!;
  assert.equal(fn2.header.offset, 0x463);
  assert.equal(fn2.header.paramCount, 1);
  assert.equal(fn2.header.loopDepth, 0);
  assert.equal(fn2.header.bytecodeSizeInBytes, 24);
  assert.equal(fn2.header.numberRegCount, 1);
  assert.equal(fn2.header.nonPtrRegCount, 0);
  assert.equal(fn2.header.frameSize, 2);
  assert.equal(fn2.header.flags.kind, "Generator");
  assert.equal(fn2.header.fromLargeHeader, false);

  const fn4 = m.functions[4]!;
  assert.equal(fn4.header.offset, 0x4d4);
  assert.equal(fn4.header.paramCount, 2);
  assert.equal(fn4.header.frameSize, 3);
  assert.equal(fn4.header.flags.kind, "Generator");

  const fn0 = m.functions[0]!;
  assert.equal(fn0.header.fromLargeHeader, true);
  assert.equal(fn0.header.offset, 0x358);
  assert.equal(fn0.header.paramCount, 1);
  assert.equal(fn0.header.loopDepth, 0);
  assert.equal(fn0.header.bytecodeSizeInBytes, 236);
  assert.equal(fn0.header.functionNameStringId, 6);
  assert.equal(fn0.header.numberRegCount, 1);
  assert.equal(fn0.header.nonPtrRegCount, 1);
  assert.equal(fn0.header.frameSize, 18);
  assert.equal(fn0.header.readCacheSize, 9);
  assert.equal(fn0.header.writeCacheSize, 5);
  assert.equal(fn0.header.privateNameCacheSize, 0);
  assert.equal(fn0.header.flags.raw, 0x12);
});
