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

function constructsBin(name: string, version: number) {
  const f = fixture("constructs", name);
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`missing constructs/${name} v${version}`);
  return b.bytes();
}

// M1 bug fix: hbc98-late (layout class E)'s *unpacked* large FunctionHeader gained
// an extra full-byte NumCacheNewObject field (Hermes commit f74f6bbe37, present
// only for BYTECODE_VERSION 98, reverted by 913d31acd1 before v99 shipped),
// squeezed into small-header byte 10 as a 1-bit sub-field but promoted to a whole
// byte of its own in the large header (docs/HBC-FORMAT.md's one-member-per-field
// convention). That makes v98's large header 37 bytes, not 36, shifting `flags`
// from offset 35 to 36 — every real (i.e. overflowed) v98 function's flags were
// being read one byte early, off the tail of `privateNameCacheSize` instead.
// Ground truth: `tools/hermesc/v98/hermesc -dump-bytecode` on byte-identical
// recompiles (tests/gate/oracle/known-divergences.md item 4) — a bare
// `Function<name>` header line means prohibitInvoke:"none"; `NCFunction<name>`
// means "construct" (call prohibited); `Constructor<name>` means "call"
// (construct-only). Independently cross-checked against this project's own
// (already-correct, structurally unaffected by this bug) v99 decode of the same
// three sources, which agrees byte-for-byte on every value asserted below.
test("v98 (layout class E, hbc98-late) large-header flags decode byte-exact on 3 fixtures (M1 bug fix)", () => {
  // 32-class-basic: hermesc dump shows global=Function (none), Point=Constructor
  // (call), the 3 methods=NCFunction (construct) -- was, before the fix,
  // "call"/overflowed:true for every one of the 5 functions including global.
  {
    const m = parseHbc(constructsBin("32-class-basic", 98));
    const expected: readonly [string, "none" | "call" | "construct", number][] = [
      ["global", "none", 0x12],
      ["Point", "call", 0x14],
      ["distanceFromOrigin", "construct", 0x15],
      ["toString", "construct", 0x15],
      ["translate", "construct", 0x15],
    ];
    assert.equal(m.functions.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      const f = m.functions[i]!;
      const [name, prohibitInvoke, flagsRaw] = expected[i]!;
      assert.equal(f.name, name, `fn${i}.name`);
      assert.equal(f.header.fromLargeHeader, true, `fn${i}.fromLargeHeader`);
      assert.equal(f.header.flags.prohibitInvoke, prohibitInvoke, `fn${i}.prohibitInvoke`);
      assert.equal(f.header.flags.raw, flagsRaw, `fn${i}.flags.raw`);
    }
  }

  // 01-if-else-chain: hermesc dump shows global=Function (none) with a genuine
  // Exception Handlers block (the for-of loop's iterator-close finally) -- was,
  // before the fix, hasExceptionHandler:false with an empty exceptionHandlers
  // array. The exact tuple matches this project's own v99 decode of the same
  // source byte-for-byte (v98/v99 opcode tables agree below opcode 165, spec 01
  // §5.2.1, and this function never reaches a distinguishing opcode).
  {
    const m = parseHbc(constructsBin("01-if-else-chain", 98));
    const global = m.functions[0]!;
    assert.equal(global.name, "global");
    assert.equal(global.header.fromLargeHeader, true);
    assert.equal(global.header.flags.prohibitInvoke, "none");
    assert.equal(global.header.flags.hasExceptionHandler, true);
    assert.equal(global.header.flags.raw, 0x1a);
    assert.deepEqual(
      global.exceptionHandlers.map((h) => [h.start, h.end, h.target]),
      [[60, 85, 85]],
    );
    const check = m.functions[1]!;
    assert.equal(check.name, "check");
    assert.equal(check.header.flags.prohibitInvoke, "none");
    assert.equal(check.header.flags.hasExceptionHandler, false);
  }

  // 33-class-inheritance-super: 9 functions covering all three prohibitInvoke
  // states in one file (hermesc: Function<global>, Constructor<Animal/Dog/Puppy>,
  // NCFunction<speak/describe> x3). Forces hbc98-late explicitly: this fixture's
  // bytecode never reaches an opcode where the hbc98-late/hbc99-mar2026 tables
  // disagree, so P3's full-decode tie-break is genuinely ambiguous between them
  // (§6.4) -- irrelevant to this flags-decode bug, which is independent of which
  // of those two tables is chosen.
  {
    const m = parseHbc(constructsBin("33-class-inheritance-super", 98), { opcodeTable: "hbc98-late" });
    const expected: readonly [string, "none" | "call" | "construct", number][] = [
      ["global", "none", 0x12],
      ["Animal", "call", 0x14],
      ["speak", "construct", 0x15],
      ["describe", "construct", 0x15],
      ["Dog", "call", 0x14],
      ["speak", "construct", 0x15],
      ["describe", "construct", 0x15],
      ["Puppy", "call", 0x14],
      ["speak", "construct", 0x15],
    ];
    assert.equal(m.functions.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      const f = m.functions[i]!;
      const [name, prohibitInvoke, flagsRaw] = expected[i]!;
      assert.equal(f.name, name, `fn${i}.name`);
      assert.equal(f.header.flags.prohibitInvoke, prohibitInvoke, `fn${i}.prohibitInvoke`);
      assert.equal(f.header.flags.raw, flagsRaw, `fn${i}.flags.raw`);
    }
  }
});

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
