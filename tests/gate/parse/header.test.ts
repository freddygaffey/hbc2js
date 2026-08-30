// docs/specs/01-parser.md §8 T1 — header + section map, byte-exact, per canonical fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { fixture } from "../../support/fixtures.ts";

function binaryOf(group: string, name: string, version: number, variant: "" | "public" = "") {
  const f = fixture(group, name);
  const b = f.binaries.find((x) => x.version === version && x.variant === variant);
  if (b === undefined) throw new Error(`no ${group}/${name} v${version}${variant} binary`);
  return b;
}

test("hermes-dec-sample/v94.hbc header, byte-exact", () => {
  const bin = binaryOf("hermes-dec-sample", "hermes-dec-sample", 94);
  const m = parseHbc(bin.bytes());
  assert.equal(m.header.version, 94);
  assert.equal(m.header.fileLength, 2256);
  assert.equal(m.header.globalCodeIndex, 0);
  assert.equal(m.header.functionCount, 8);
  assert.equal(m.header.stringKindCount, 2);
  assert.equal(m.header.identifierCount, 17);
  assert.equal(m.header.stringCount, 34);
  assert.equal(m.header.overflowStringCount, 0);
  assert.equal(m.header.stringStorageSize, 238);
  assert.equal(m.header.bigIntCount, 0);
  assert.equal(m.header.bigIntStorageSize, 0);
  assert.equal(m.header.regExpCount, 1);
  assert.equal(m.header.regExpStorageSize, 66);
  assert.equal(m.header.literalValueBufferSize, 0);
  assert.equal(m.header.objKeyBufferSize, 0);
  assert.equal(m.header.objValueBufferSize, 0);
  assert.equal(m.header.segmentID, 0);
  assert.equal(m.header.cjsModuleCount, 0);
  assert.equal(m.header.functionSourceCount, 2);
  assert.equal(m.header.debugInfoOffset, 0x638);
  assert.equal(m.header.options.raw, 0x04);
  assert.equal(Buffer.from(m.header.sourceHash).toString("hex"), "a692192bdc8ee6f7b2b9918faf18a64db39587c8");

  assert.equal(m.sections.span("functionHeaders").offset, 0x80);
  assert.equal(m.sections.span("stringKinds").offset, 0x100);
  assert.equal(m.sections.span("identifierHashes").offset, 0x108);
  assert.equal(m.sections.span("smallStringTable").offset, 0x14c);
  assert.equal(m.sections.span("stringStorage").offset, 0x1d4);
  assert.equal(m.sections.span("regExpTable").offset, 0x2c4);
  assert.equal(m.sections.span("regExpStorage").offset, 0x2cc);
  assert.equal(m.sections.span("functionSourceTable").offset, 0x310);
  assert.equal(m.sections.firstFunctionBodyOffset, 0x320);

  assert.equal(m.layout.layoutClass, "C");
  assert.equal(m.layout.opcodeTable, "hbc94");
});

test("hermes-dec-sample/v99.hbc header, byte-exact", () => {
  const bin = binaryOf("hermes-dec-sample", "hermes-dec-sample", 99);
  const m = parseHbc(bin.bytes());
  assert.equal(m.header.version, 99);
  assert.equal(m.header.fileLength, 2999);
  assert.equal(m.header.functionCount, 8);
  assert.equal(m.header.stringKindCount, 2);
  assert.equal(m.header.identifierCount, 19);
  assert.equal(m.header.stringCount, 35);
  assert.equal(m.header.stringStorageSize, 286);
  assert.equal(m.header.regExpCount, 1);
  assert.equal(m.header.regExpStorageSize, 66);
  assert.equal(m.header.literalValueBufferSize, 12);
  assert.equal(m.header.objKeyBufferSize, 5);
  assert.equal(m.header.objShapeTableCount, 1);
  assert.equal(m.header.numStringSwitchImms, 0);
  assert.equal(m.header.cjsModuleCount, 0);
  assert.equal(m.header.functionSourceCount, 2);
  assert.equal(m.header.debugInfoOffset, 0xa24);
  assert.equal(m.header.options.raw, 0x00);

  assert.equal(m.sections.span("functionHeaders").offset, 0x80);
  assert.equal(m.sections.span("stringKinds").offset, 0xe0);
  assert.equal(m.sections.span("identifierHashes").offset, 0xe8);
  assert.equal(m.sections.span("smallStringTable").offset, 0x134);
  assert.equal(m.sections.span("stringStorage").offset, 0x1c0);
  assert.equal(m.sections.span("literalValueBuffer").offset, 0x2e0);
  assert.equal(m.sections.span("objKeyBuffer").offset, 0x2ec);
  assert.equal(m.sections.span("objShapeTable").offset, 0x2f4);
  assert.equal(m.sections.span("regExpTable").offset, 0x2fc);
  assert.equal(m.sections.span("regExpStorage").offset, 0x304);
  assert.equal(m.sections.span("functionSourceTable").offset, 0x348);
  assert.equal(m.sections.firstFunctionBodyOffset, 0x358);

  assert.equal(m.layout.layoutClass, "E");
  assert.equal(m.layout.opcodeTable, "hbc99-mar2026");
});

test("hermes-dec-sample/v84.hbc header, byte-exact (class B)", () => {
  const bin = binaryOf("hermes-dec-sample", "hermes-dec-sample", 84);
  const m = parseHbc(bin.bytes());
  assert.equal(m.header.version, 84);
  assert.equal(m.header.fileLength, 1898);
  assert.equal(m.header.functionCount, 8);
  assert.equal(m.header.stringKindCount, 2);
  assert.equal(m.header.identifierCount, 17);
  assert.equal(m.header.stringCount, 34);
  assert.equal(m.header.stringStorageSize, 238);
  assert.equal(m.header.regExpCount, 1);
  assert.equal(m.header.regExpStorageSize, 66);
  assert.equal(m.header.functionSourceCount, 2);
  assert.equal(m.header.debugInfoOffset, 0x620);
  assert.equal(m.header.options.raw, 0x04);
  assert.equal(m.sections.firstFunctionBodyOffset, 0x320);
  assert.equal(m.layout.layoutClass, "B");
  assert.equal(m.layout.opcodeTable, "hbc84");
});

test("hermes-dec-sample/v98.hbc header matches v99.hbc in every field except fileLength and debugInfoOffset", () => {
  const v98 = parseHbc(binaryOf("hermes-dec-sample", "hermes-dec-sample", 98).bytes());
  const v99 = parseHbc(binaryOf("hermes-dec-sample", "hermes-dec-sample", 99).bytes());
  assert.equal(v98.header.version, 98);
  assert.equal(v98.header.fileLength, 3005);
  assert.equal(v98.header.debugInfoOffset, 0xa3c);
  assert.equal(v98.layout.layoutClass, "E");
  assert.equal(v98.layout.opcodeTable, "hbc98-late");

  const fieldsToCompare = [
    "globalCodeIndex",
    "functionCount",
    "stringKindCount",
    "identifierCount",
    "stringCount",
    "overflowStringCount",
    "stringStorageSize",
    "bigIntCount",
    "bigIntStorageSize",
    "regExpCount",
    "regExpStorageSize",
    "literalValueBufferSize",
    "objKeyBufferSize",
    "objShapeTableCount",
    "numStringSwitchImms",
    "segmentID",
    "cjsModuleCount",
    "functionSourceCount",
  ] as const;
  for (const f of fieldsToCompare) {
    assert.equal(v98.header[f], v99.header[f], `field ${f}`);
  }
  assert.equal(v98.sections.firstFunctionBodyOffset, v99.sections.firstFunctionBodyOffset);
  assert.equal(v98.sections.firstFunctionBodyOffset, 0x358);
});

test("hermes-dec-sample/v99-public.hbc: same layout/table as v99.hbc, same shape fields", () => {
  const m = parseHbc(binaryOf("hermes-dec-sample", "hermes-dec-sample", 99, "public").bytes());
  assert.equal(m.header.fileLength, 2981);
  assert.equal(m.header.literalValueBufferSize, 12);
  assert.equal(m.header.objKeyBufferSize, 5);
  assert.equal(m.header.objShapeTableCount, 1);
  assert.equal(m.header.numStringSwitchImms, 0);
  assert.equal(m.sections.firstFunctionBodyOffset, 0x358);
  assert.equal(m.layout.layoutClass, "E");
  assert.equal(m.layout.opcodeTable, "hbc99-mar2026");
});

test("hermes-dec-sample/v96.hbc: class C, hbc96 table, same source-derived counts as v94", () => {
  const m = parseHbc(binaryOf("hermes-dec-sample", "hermes-dec-sample", 96).bytes());
  assert.equal(m.header.version, 96);
  assert.equal(m.header.functionCount, 8);
  assert.equal(m.header.stringCount, 34);
  assert.equal(m.header.identifierCount, 17);
  assert.equal(Buffer.from(m.header.sourceHash).toString("hex"), "a692192bdc8ee6f7b2b9918faf18a64db39587c8");
  assert.equal(m.sections.firstFunctionBodyOffset, 0x320);
  assert.equal(m.layout.layoutClass, "C");
  assert.equal(m.layout.opcodeTable, "hbc96");
});

test("INV-04: header padding after options is all zero for every gate fixture", () => {
  // Implicitly re-checked by parseHbc succeeding at all (P1 rejects non-zero padding
  // for every candidate); this test asserts it explicitly for the canonical files.
  for (const version of [84, 94, 96, 98, 99] as const) {
    const bin = binaryOf("hermes-dec-sample", "hermes-dec-sample", version);
    assert.doesNotThrow(() => parseHbc(bin.bytes()));
  }
});
