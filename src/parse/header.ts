// docs/specs/01-parser.md §3.2; docs/HBC-FORMAT.md §2.
// Header field extraction per layout class. This module does NOT validate — it only
// positions and reads. layout.ts's P1 probe is what judges the result sane or not,
// so that the same code path serves both "try this candidate" and "read the header
// we already committed to".
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { HbcHeader, HbcOptions, LayoutClass } from "./types.ts";

export const HBC_MAGIC = 0x1f1903c103bc1fc6n;
export const HEADER_SIZE = 128;

/** Byte offset of each optional/positioned field, per docs/HBC-FORMAT.md §2. Classes
 *  A and B have no vendored fixture (O-2 in spec 01) — their offsets are derived from
 *  the documented "subtract 8 from class C, class A additionally drops
 *  functionSourceCount" rule and are UNVERIFIED against real bytes. */
interface ClassOffsets {
  readonly hasBigInt: boolean;
  readonly bigIntCount?: number;
  readonly bigIntStorageSize?: number;
  readonly regExpCount: number;
  readonly regExpStorageSize: number;
  readonly literalValueBufferSize: number; // arrayBufferSize pre-v97, same slot
  readonly objKeyBufferSize: number;
  readonly hasShapeTable: boolean;
  readonly objValueBufferSize?: number; // v<=96
  readonly objShapeTableCount?: number; // v>=97
  readonly hasStringSwitchImms: boolean;
  readonly numStringSwitchImms?: number; // class E only
  readonly segmentID: number;
  readonly cjsModuleCount: number;
  readonly hasFunctionSourceCount: boolean;
  readonly functionSourceCount?: number; // v>=84
  readonly debugInfoOffset: number;
  readonly options: number;
}

const CLASS_OFFSETS: Readonly<Record<LayoutClass, ClassOffsets>> = {
  A: {
    hasBigInt: false,
    regExpCount: 64,
    regExpStorageSize: 68,
    literalValueBufferSize: 72,
    objKeyBufferSize: 76,
    hasShapeTable: false,
    objValueBufferSize: 80,
    hasStringSwitchImms: false,
    segmentID: 84,
    cjsModuleCount: 88,
    hasFunctionSourceCount: false,
    debugInfoOffset: 92,
    options: 96,
  },
  B: {
    hasBigInt: false,
    regExpCount: 64,
    regExpStorageSize: 68,
    literalValueBufferSize: 72,
    objKeyBufferSize: 76,
    hasShapeTable: false,
    objValueBufferSize: 80,
    hasStringSwitchImms: false,
    segmentID: 84,
    cjsModuleCount: 88,
    hasFunctionSourceCount: true,
    functionSourceCount: 92,
    debugInfoOffset: 96,
    options: 100,
  },
  C: {
    hasBigInt: true,
    bigIntCount: 64,
    bigIntStorageSize: 68,
    regExpCount: 72,
    regExpStorageSize: 76,
    literalValueBufferSize: 80,
    objKeyBufferSize: 84,
    hasShapeTable: false,
    objValueBufferSize: 88,
    hasStringSwitchImms: false,
    segmentID: 92,
    cjsModuleCount: 96,
    hasFunctionSourceCount: true,
    functionSourceCount: 100,
    debugInfoOffset: 104,
    options: 108,
  },
  D: {
    hasBigInt: true,
    bigIntCount: 64,
    bigIntStorageSize: 68,
    regExpCount: 72,
    regExpStorageSize: 76,
    literalValueBufferSize: 80,
    objKeyBufferSize: 84,
    hasShapeTable: true,
    objShapeTableCount: 88,
    hasStringSwitchImms: false,
    segmentID: 92,
    cjsModuleCount: 96,
    hasFunctionSourceCount: true,
    functionSourceCount: 100,
    debugInfoOffset: 104,
    options: 108,
  },
  E: {
    hasBigInt: true,
    bigIntCount: 64,
    bigIntStorageSize: 68,
    regExpCount: 72,
    regExpStorageSize: 76,
    literalValueBufferSize: 80,
    objKeyBufferSize: 84,
    hasShapeTable: true,
    objShapeTableCount: 88,
    hasStringSwitchImms: true,
    numStringSwitchImms: 92,
    segmentID: 96,
    cjsModuleCount: 100,
    hasFunctionSourceCount: true,
    functionSourceCount: 104,
    debugInfoOffset: 108,
    options: 112,
  },
};

function decodeOptions(raw: number): HbcOptions {
  return {
    staticBuiltins: (raw & 0x1) !== 0,
    cjsModulesStaticallyResolved: (raw & 0x2) !== 0,
    hasAsync: (raw & 0x4) !== 0,
    raw,
  };
}

/** Read every header field for one candidate layout class. Never throws for
 *  "implausible values" (that is P1's job) — only for physically insufficient bytes,
 *  which INV-00 guarantees cannot happen by the time this is called. */
export function readHeaderFields(bytes: Uint8Array, layoutClass: LayoutClass): HbcHeader {
  if (bytes.length < HEADER_SIZE) {
    throw new Hbc2jsError(ErrorCode.E_TRUNCATED, `file is ${bytes.length} bytes, header needs ${HEADER_SIZE}`, { offset: 0 });
  }
  const r = new BinaryReader(bytes, "header");
  const magic = r.u64();
  const version = r.u32();
  const sourceHash = r.bytes(20);
  const fileLength = r.u32();
  const globalCodeIndex = r.u32();
  const functionCount = r.u32();
  const stringKindCount = r.u32();
  const identifierCount = r.u32();
  const stringCount = r.u32();
  const overflowStringCount = r.u32();
  const stringStorageSize = r.u32();

  const o = CLASS_OFFSETS[layoutClass];
  const bigIntCount = o.hasBigInt ? r.peekU32(o.bigIntCount!) : 0;
  const bigIntStorageSize = o.hasBigInt ? r.peekU32(o.bigIntStorageSize!) : 0;
  const regExpCount = r.peekU32(o.regExpCount);
  const regExpStorageSize = r.peekU32(o.regExpStorageSize);
  const literalValueBufferSize = r.peekU32(o.literalValueBufferSize);
  const objKeyBufferSize = r.peekU32(o.objKeyBufferSize);
  const objValueBufferSize = o.hasShapeTable ? 0 : r.peekU32(o.objValueBufferSize!);
  const objShapeTableCount = o.hasShapeTable ? r.peekU32(o.objShapeTableCount!) : 0;
  const numStringSwitchImms = o.hasStringSwitchImms ? r.peekU32(o.numStringSwitchImms!) : 0;
  const segmentID = r.peekU32(o.segmentID);
  const cjsModuleCount = r.peekU32(o.cjsModuleCount);
  const functionSourceCount = o.hasFunctionSourceCount ? r.peekU32(o.functionSourceCount!) : 0;
  const debugInfoOffset = r.peekU32(o.debugInfoOffset);
  const optionsRaw = bytes[o.options] ?? 0;

  return {
    magic,
    version,
    sourceHash,
    fileLength,
    globalCodeIndex,
    functionCount,
    stringKindCount,
    identifierCount,
    stringCount,
    overflowStringCount,
    stringStorageSize,
    bigIntCount,
    bigIntStorageSize,
    regExpCount,
    regExpStorageSize,
    literalValueBufferSize,
    objKeyBufferSize,
    objValueBufferSize,
    objShapeTableCount,
    numStringSwitchImms,
    segmentID,
    cjsModuleCount,
    functionSourceCount,
    debugInfoOffset,
    options: decodeOptions(optionsRaw),
  };
}

/** Padding bytes after `options`, per class (docs/HBC-FORMAT.md §2). */
export function paddingRange(layoutClass: LayoutClass): { start: number; length: number } {
  const start = CLASS_OFFSETS[layoutClass].options + 1;
  return { start, length: HEADER_SIZE - start };
}

export function optionsOffset(layoutClass: LayoutClass): number {
  return CLASS_OFFSETS[layoutClass].options;
}

export interface ClassLayoutConstants {
  readonly smallFuncHeaderSize: 12 | 16;
  readonly largeFuncHeaderSize: 23 | 31 | 36;
  readonly debugOffsetsSize: 4 | 8 | 12;
  readonly funcKindInFlags: boolean;
  readonly hasBigIntTable: boolean;
  readonly hasShapeTable: boolean;
  readonly hasFunctionSourceTable: boolean;
  readonly hasStringSwitchImms: boolean;
}

/** docs/HBC-FORMAT.md §0.1, §3 — everything about a layout class that doesn't depend
 *  on which opcode table is chosen. Shared by layout.ts (building LayoutProfile) and
 *  functions.ts (reading function headers), so the two can never disagree. */
export function classLayoutConstants(layoutClass: LayoutClass): ClassLayoutConstants {
  const o = CLASS_OFFSETS[layoutClass];
  switch (layoutClass) {
    case "A":
      return { smallFuncHeaderSize: 16, largeFuncHeaderSize: 31, debugOffsetsSize: 8, funcKindInFlags: false, hasBigIntTable: o.hasBigInt, hasShapeTable: o.hasShapeTable, hasFunctionSourceTable: o.hasFunctionSourceCount, hasStringSwitchImms: o.hasStringSwitchImms };
    case "B":
    case "C":
      return { smallFuncHeaderSize: 16, largeFuncHeaderSize: 31, debugOffsetsSize: 12, funcKindInFlags: false, hasBigIntTable: o.hasBigInt, hasShapeTable: o.hasShapeTable, hasFunctionSourceTable: o.hasFunctionSourceCount, hasStringSwitchImms: o.hasStringSwitchImms };
    case "D":
      return { smallFuncHeaderSize: 12, largeFuncHeaderSize: 23, debugOffsetsSize: 4, funcKindInFlags: true, hasBigIntTable: o.hasBigInt, hasShapeTable: o.hasShapeTable, hasFunctionSourceTable: o.hasFunctionSourceCount, hasStringSwitchImms: o.hasStringSwitchImms };
    case "E":
      return { smallFuncHeaderSize: 12, largeFuncHeaderSize: 36, debugOffsetsSize: 4, funcKindInFlags: true, hasBigIntTable: o.hasBigInt, hasShapeTable: o.hasShapeTable, hasFunctionSourceTable: o.hasFunctionSourceCount, hasStringSwitchImms: o.hasStringSwitchImms };
  }
}
