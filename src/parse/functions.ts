// docs/specs/01-parser.md §3.4, §4 — function headers (small + large, both eras),
// info blocks (exception handlers + debug offsets). docs/HBC-FORMAT.md §3, §4.
import { extractBits } from "../util/bits.ts";
import { BinaryReader } from "../util/reader.ts";
import { classLayoutConstants } from "./header.ts";
import { readExceptionTable } from "./exceptions.ts";
import { readDebugOffsets } from "./debug.ts";
import type { DebugOffsets, ExceptionHandler, FuncKind, FunctionFlags, FunctionHeader, LayoutClass, ProhibitInvoke } from "./types.ts";

function decodeProhibitInvoke(v: number): ProhibitInvoke {
  if (v === 0) return "call";
  if (v === 1) return "construct";
  return "none";
}

function decodeFlags(raw: number, funcKindInFlags: boolean): FunctionFlags {
  const prohibitInvoke = decodeProhibitInvoke(extractBits(raw, 0, 2));
  const strictMode = extractBits(raw, 2, 1) !== 0;
  const hasExceptionHandler = extractBits(raw, 3, 1) !== 0;
  const hasDebugInfo = extractBits(raw, 4, 1) !== 0;
  const overflowed = extractBits(raw, 5, 1) !== 0;
  let kind: FuncKind = "Normal";
  let kindKnown = false;
  if (funcKindInFlags) {
    const k = extractBits(raw, 6, 2);
    kindKnown = true;
    kind = k === 1 ? "Generator" : k === 2 ? "Async" : "Normal";
  }
  return { prohibitInvoke, strictMode, hasExceptionHandler, hasDebugInfo, overflowed, kind, kindKnown, raw };
}

interface RawSmallHeader {
  readonly offsetField: number;
  readonly paramCount: number;
  readonly bytecodeSizeInBytes: number;
  readonly functionNameField: number;
  readonly frameSize: number;
  readonly infoOffsetField: number | undefined; // classes A-C only
  readonly environmentSize: number | undefined; // classes A-C only
  readonly loopDepth: number | undefined; // class E only
  readonly numberRegCount: number | undefined; // class E only
  readonly nonPtrRegCount: number | undefined; // class E only
  readonly readCacheSize: number;
  readonly writeCacheSize: number;
  readonly privateNameCacheSize: number | undefined; // class E only
  readonly flags: FunctionFlags;
}

function readSmallHeaderAt(bytes: Uint8Array, offset: number, layoutClass: LayoutClass, version: number): RawSmallHeader {
  const c = classLayoutConstants(layoutClass, version);
  const r = new BinaryReader(bytes.subarray(offset, offset + c.smallFuncHeaderSize), "functionHeaders");
  if (layoutClass === "A" || layoutClass === "B" || layoutClass === "C") {
    const word0 = r.u32();
    const offsetField = extractBits(word0, 0, 25);
    const paramCount = extractBits(word0, 25, 7);
    const word1 = r.u32();
    const bytecodeSizeInBytes = extractBits(word1, 0, 15);
    const functionNameField = extractBits(word1, 15, 17);
    const word2 = r.u32();
    const infoOffsetField = extractBits(word2, 0, 25);
    const frameSize = extractBits(word2, 25, 7);
    const environmentSize = r.u8();
    const readCacheSize = r.u8();
    const writeCacheSize = r.u8();
    const flagsRaw = r.u8();
    return {
      offsetField,
      paramCount,
      bytecodeSizeInBytes,
      functionNameField,
      frameSize,
      infoOffsetField,
      environmentSize,
      loopDepth: undefined,
      numberRegCount: undefined,
      nonPtrRegCount: undefined,
      readCacheSize,
      writeCacheSize,
      privateNameCacheSize: undefined,
      flags: decodeFlags(flagsRaw, false),
    };
  }
  if (layoutClass === "D") {
    const word0 = r.u32();
    const offsetField = extractBits(word0, 0, 25);
    const paramCount = extractBits(word0, 25, 7);
    const word1 = r.u32();
    const bytecodeSizeInBytes = extractBits(word1, 0, 15);
    const functionNameField = extractBits(word1, 15, 17);
    const frameSize = r.u8();
    const readCacheSize = r.u8();
    const writeCacheSize = r.u8();
    const flagsRaw = r.u8();
    return {
      offsetField,
      paramCount,
      bytecodeSizeInBytes,
      functionNameField,
      frameSize,
      infoOffsetField: undefined,
      environmentSize: undefined,
      loopDepth: undefined,
      numberRegCount: undefined,
      nonPtrRegCount: undefined,
      readCacheSize,
      writeCacheSize,
      privateNameCacheSize: undefined,
      flags: decodeFlags(flagsRaw, true),
    };
  }
  // class E
  const word0 = r.u32();
  const offsetField = extractBits(word0, 0, 25);
  const paramCount = extractBits(word0, 25, 5);
  const loopDepth = extractBits(word0, 30, 2);
  const word1 = r.u32();
  const bytecodeSizeInBytes = extractBits(word1, 0, 14);
  const functionNameField = extractBits(word1, 14, 8);
  const numberRegCount = extractBits(word1, 22, 5);
  const nonPtrRegCount = extractBits(word1, 27, 5);
  const frameSize = r.u8();
  const readCacheSize = r.u8();
  const b10 = r.u8();
  // hbc98-late only (Hermes commit f74f6bbe37, reverted by 913d31acd1 before v99
  // shipped): byte 10 briefly re-split as writeCacheSize:6/numCacheNewObject:1
  // (discarded, not part of the public API) instead of the standard
  // writeCacheSize:7 — see ClassLayoutConstants.hasNumCacheNewObjectField.
  // privateNameCacheSize stays the top bit either way, so it's unaffected.
  const writeCacheSize = extractBits(b10, 0, c.hasNumCacheNewObjectField ? 6 : 7);
  const privateNameCacheSize = extractBits(b10, 7, 1);
  const flagsRaw = r.u8();
  return {
    offsetField,
    paramCount,
    bytecodeSizeInBytes,
    functionNameField,
    frameSize,
    infoOffsetField: undefined,
    environmentSize: undefined,
    loopDepth,
    numberRegCount,
    nonPtrRegCount,
    readCacheSize,
    writeCacheSize,
    privateNameCacheSize,
    flags: decodeFlags(flagsRaw, true),
  };
}

/** docs/HBC-FORMAT.md §3.1-3.3 — packed pointer to an overflowed function's info
 *  block / large header, computed from small-header RAW field values. */
function largeHeaderOffset(small: RawSmallHeader, layoutClass: LayoutClass): number {
  if (layoutClass === "A" || layoutClass === "B" || layoutClass === "C") {
    return ((small.infoOffsetField! << 16) | (small.offsetField & 0xffff)) >>> 0;
  }
  if (layoutClass === "D") {
    return ((small.functionNameField << 16) | (small.offsetField & 0xffff)) >>> 0;
  }
  return ((small.functionNameField << 24) | (small.offsetField & 0xffffff)) >>> 0;
}

interface LargeHeaderFields {
  readonly offset: number;
  readonly paramCount: number;
  readonly bytecodeSizeInBytes: number;
  readonly functionName: number;
  readonly frameSize: number;
  readonly infoOffset: number | undefined;
  readonly environmentSize: number | undefined;
  readonly loopDepth: number | undefined;
  readonly numberRegCount: number | undefined;
  readonly nonPtrRegCount: number | undefined;
  readonly readCacheSize: number;
  readonly writeCacheSize: number;
  readonly privateNameCacheSize: number | undefined;
  readonly flags: FunctionFlags;
  readonly consumedBytes: number;
}

function readLargeHeaderAt(bytes: Uint8Array, offset: number, layoutClass: LayoutClass, version: number): LargeHeaderFields {
  const c = classLayoutConstants(layoutClass, version);
  const r = new BinaryReader(bytes.subarray(offset, offset + c.largeFuncHeaderSize), "functionInfo");
  if (layoutClass === "A" || layoutClass === "B" || layoutClass === "C") {
    const off = r.u32();
    const paramCount = r.u32();
    const bytecodeSizeInBytes = r.u32();
    const functionName = r.u32();
    const infoOffset = r.u32();
    const frameSize = r.u32();
    const environmentSize = r.u32();
    const readCacheSize = r.u8();
    const writeCacheSize = r.u8();
    const flagsRaw = r.u8();
    return {
      offset: off,
      paramCount,
      bytecodeSizeInBytes,
      functionName,
      frameSize,
      infoOffset,
      environmentSize,
      loopDepth: undefined,
      numberRegCount: undefined,
      nonPtrRegCount: undefined,
      readCacheSize,
      writeCacheSize,
      privateNameCacheSize: undefined,
      flags: decodeFlags(flagsRaw, false),
      consumedBytes: c.largeFuncHeaderSize,
    };
  }
  if (layoutClass === "D") {
    const off = r.u32();
    const paramCount = r.u32();
    const bytecodeSizeInBytes = r.u32();
    const functionName = r.u32();
    const frameSize = r.u32();
    const readCacheSize = r.u8();
    const writeCacheSize = r.u8();
    const flagsRaw = r.u8();
    return {
      offset: off,
      paramCount,
      bytecodeSizeInBytes,
      functionName,
      frameSize,
      infoOffset: undefined,
      environmentSize: undefined,
      loopDepth: undefined,
      numberRegCount: undefined,
      nonPtrRegCount: undefined,
      readCacheSize,
      writeCacheSize,
      privateNameCacheSize: undefined,
      flags: decodeFlags(flagsRaw, true),
      consumedBytes: c.largeFuncHeaderSize,
    };
  }
  // class E
  const off = r.u32();
  const paramCount = r.u32();
  const loopDepth = r.u32();
  const bytecodeSizeInBytes = r.u32();
  const functionName = r.u32();
  const numberRegCount = r.u32();
  const nonPtrRegCount = r.u32();
  const frameSize = r.u32();
  const readCacheSize = r.u8();
  const writeCacheSize = r.u8();
  // hbc98-late only: an extra full-byte NumCacheNewObject field sits between
  // WriteCacheSize and PrivateNameCacheSize in the *unpacked* large header (each
  // field gets its own byte-or-wider member regardless of its packed bit-width —
  // docs/HBC-FORMAT.md's `DECLARE_FIELD` convention), growing this header to 37
  // bytes and shifting `flags` from offset 35 to 36. Reverted before v99 shipped.
  // Discarded here: not part of the public API, and its value is redundant with
  // the small header's per docs/HBC-FORMAT.md §3.3.
  if (c.hasNumCacheNewObjectField) r.u8();
  const privateNameCacheSize = r.u8();
  const flagsRaw = r.u8();
  return {
    offset: off,
    paramCount,
    bytecodeSizeInBytes,
    functionName,
    frameSize,
    infoOffset: undefined,
    environmentSize: undefined,
    loopDepth,
    numberRegCount,
    nonPtrRegCount,
    readCacheSize,
    writeCacheSize,
    privateNameCacheSize,
    flags: decodeFlags(flagsRaw, true),
    consumedBytes: c.largeFuncHeaderSize,
  };
}

export interface ResolvedFunction {
  readonly header: FunctionHeader;
  readonly exceptionHandlers: readonly ExceptionHandler[];
  readonly debugOffsets: DebugOffsets | null;
  /** INV-17 — class E (D too): a non-overflowed function claims hasExceptionHandler
   *  or hasDebugInfo, which docs/HBC-FORMAT.md §3.3 says should be impossible
   *  (`serializeFunctionTable` always overflows such functions). Diagnostic, not fatal. */
  readonly unexpectedInfoFlags: boolean;
}

/** Resolve one function's complete header + info block. `bytes` is the whole file.
 *  `version` (spec 01 §6.1's already-established layout-class version) only affects
 *  class E — see `ClassLayoutConstants.hasNumCacheNewObjectField`. */
export function readFunctionRecord(bytes: Uint8Array, smallHeaderOffset: number, index: number, layoutClass: LayoutClass, version: number): ResolvedFunction {
  const c = classLayoutConstants(layoutClass, version);
  const small = readSmallHeaderAt(bytes, smallHeaderOffset, layoutClass, version);

  let header: FunctionHeader;
  let infoBlockStart: number | undefined;

  if (small.flags.overflowed) {
    const lho = largeHeaderOffset(small, layoutClass);
    const large = readLargeHeaderAt(bytes, lho, layoutClass, version);
    header = {
      index,
      offset: large.offset,
      paramCount: large.paramCount,
      bytecodeSizeInBytes: large.bytecodeSizeInBytes,
      functionNameStringId: large.functionName,
      frameSize: large.frameSize,
      infoOffset: lho,
      environmentSize: large.environmentSize,
      loopDepth: large.loopDepth,
      numberRegCount: large.numberRegCount,
      nonPtrRegCount: large.nonPtrRegCount,
      readCacheSize: large.readCacheSize,
      writeCacheSize: large.writeCacheSize,
      privateNameCacheSize: large.privateNameCacheSize,
      // The large header carries its OWN flags byte, independent of (and normally
      // zeroed apart from the overflow bit in) the small header's — verified against
      // hermes-dec-sample/v99.hbc fn0: small header flags=0x20 (only `overflowed`),
      // large header flags=0x12 (the real prohibitInvoke/strictMode/hasDebugInfo/kind
      // bits; its own `overflowed` bit reads back 0, so we keep `overflowed: true`
      // from the small header rather than trust that copy). docs/HBC-FORMAT.md §3.4/
      // §3.5 states the large header's flags value but doesn't call out that it's a
      // *different* byte from the small header's — this is the discovered nuance.
      flags: { ...large.flags, overflowed: true },
      fromLargeHeader: true,
    };
    infoBlockStart = lho + large.consumedBytes;
  } else if (layoutClass === "A" || layoutClass === "B" || layoutClass === "C") {
    header = {
      index,
      offset: small.offsetField,
      paramCount: small.paramCount,
      bytecodeSizeInBytes: small.bytecodeSizeInBytes,
      functionNameStringId: small.functionNameField,
      frameSize: small.frameSize,
      infoOffset: small.infoOffsetField,
      environmentSize: small.environmentSize,
      loopDepth: undefined,
      numberRegCount: undefined,
      nonPtrRegCount: undefined,
      readCacheSize: small.readCacheSize,
      writeCacheSize: small.writeCacheSize,
      privateNameCacheSize: undefined,
      flags: small.flags,
      fromLargeHeader: false,
    };
    infoBlockStart = small.infoOffsetField;
  } else {
    // classes D/E, not overflowed: NO info block at all (docs/HBC-FORMAT.md §3.3's trap).
    header = {
      index,
      offset: small.offsetField,
      paramCount: small.paramCount,
      bytecodeSizeInBytes: small.bytecodeSizeInBytes,
      functionNameStringId: small.functionNameField,
      frameSize: small.frameSize,
      infoOffset: undefined,
      environmentSize: undefined,
      loopDepth: small.loopDepth,
      numberRegCount: small.numberRegCount,
      nonPtrRegCount: small.nonPtrRegCount,
      readCacheSize: small.readCacheSize,
      writeCacheSize: small.writeCacheSize,
      privateNameCacheSize: small.privateNameCacheSize,
      flags: small.flags,
      fromLargeHeader: false,
    };
    infoBlockStart = undefined;
  }

  let exceptionHandlers: readonly ExceptionHandler[] = [];
  let debugOffsets: DebugOffsets | null = null;
  const unexpectedInfoFlags = infoBlockStart === undefined && (header.flags.hasExceptionHandler || header.flags.hasDebugInfo);

  if (infoBlockStart !== undefined && (header.flags.hasExceptionHandler || header.flags.hasDebugInfo)) {
    const r = new BinaryReader(bytes, "functionInfo");
    r.seek(infoBlockStart);
    if (header.flags.hasExceptionHandler) {
      r.align(4);
      exceptionHandlers = readExceptionTable(r, header.bytecodeSizeInBytes, index);
    }
    if (header.flags.hasDebugInfo) {
      r.align(4);
      debugOffsets = readDebugOffsets(r, c.debugOffsetsSize);
    }
  }

  return { header, exceptionHandlers, debugOffsets, unexpectedInfoFlags };
}
