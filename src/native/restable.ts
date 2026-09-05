// src/native/restable.ts — the chunk header + `ResStringPool` decoder shared by
// binary AndroidManifest.xml (AXML) and resources.arsc (ARSC).
// docs/specs/27-native-side.md §L1.2/§L1.3. Layout derived from the public
// AOSP resource-format documentation; no code copied from any tool.
import { ErrorCode, Hbc2jsError } from "../errors.ts";

export const RES_NULL_TYPE = 0x0000;
export const RES_STRING_POOL_TYPE = 0x0001;
export const RES_TABLE_TYPE = 0x0002;
export const RES_XML_TYPE = 0x0003;
export const RES_XML_START_NAMESPACE_TYPE = 0x0100;
export const RES_XML_END_NAMESPACE_TYPE = 0x0101;
export const RES_XML_START_ELEMENT_TYPE = 0x0102;
export const RES_XML_END_ELEMENT_TYPE = 0x0103;
export const RES_XML_CDATA_TYPE = 0x0104;
export const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
export const RES_TABLE_PACKAGE_TYPE = 0x0200;
export const RES_TABLE_TYPE_TYPE = 0x0201;
export const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;

export function resErr(message: string, offset: number, code: (typeof ErrorCode)[keyof typeof ErrorCode] = ErrorCode.E_SECTION_MISMATCH): Hbc2jsError {
  return new Hbc2jsError(code, message, {
    offset,
    hint: "an unreadable resource chunk is refused; the native ingester never fabricates a row (spec 27 §1.4)",
  });
}

export function ru16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw resErr("chunk read ran past end of blob", o, ErrorCode.E_TRUNCATED);
  return b[o]! | (b[o + 1]! << 8);
}

export function ru32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw resErr("chunk read ran past end of blob", o, ErrorCode.E_TRUNCATED);
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

export interface ResChunk {
  readonly type: number;
  readonly headerSize: number;
  readonly size: number;
  readonly offset: number;
}

export function readChunk(b: Uint8Array, o: number): ResChunk {
  const type = ru16(b, o);
  const headerSize = ru16(b, o + 2);
  const size = ru32(b, o + 4);
  if (headerSize < 8 || size < headerSize || o + size > b.length) {
    throw resErr(`malformed chunk header (type=0x${type.toString(16)}, headerSize=${headerSize}, size=${size})`, o, ErrorCode.E_SECTION_OVERRUN);
  }
  return { type, headerSize, size, offset: o };
}

/** Iterate the chunks that fill `[start, end)`. */
export function eachChunk(b: Uint8Array, start: number, end: number, fn: (c: ResChunk) => void): void {
  let p = start;
  while (p + 8 <= end) {
    const c = readChunk(b, p);
    fn(c);
    p += c.size;
  }
}

const FLAG_UTF8 = 1 << 8;

/** A decoded `ResStringPool`. Index -1 / 0xffffffff means "no string". */
export interface ResStringPool {
  readonly strings: readonly string[];
  at(index: number): string | null;
}

export function readStringPool(b: Uint8Array, chunk: ResChunk): ResStringPool {
  if (chunk.type !== RES_STRING_POOL_TYPE) throw resErr(`expected a string pool, got chunk type 0x${chunk.type.toString(16)}`, chunk.offset);
  const o = chunk.offset;
  const count = ru32(b, o + 8);
  const flags = ru32(b, o + 16);
  const stringsStart = ru32(b, o + 20);
  const utf8 = (flags & FLAG_UTF8) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < count; i++) {
    const off = o + stringsStart + ru32(b, o + chunk.headerSize + 4 * i);
    strings.push(utf8 ? readUtf8String(b, off) : readUtf16String(b, off));
  }
  return {
    strings,
    at(index: number): string | null {
      if (index < 0 || index === 0xffffffff || index >= strings.length) return null;
      return strings[index]!;
    },
  };
}

function readUtf16String(b: Uint8Array, o: number): string {
  let len = ru16(b, o);
  let p = o + 2;
  if ((len & 0x8000) !== 0) {
    len = ((len & 0x7fff) << 16) | ru16(b, p);
    p += 2;
  }
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(ru16(b, p + 2 * i));
  return out;
}

function readUtf8String(b: Uint8Array, o: number): string {
  let p = o;
  const readLen = (): number => {
    let n = b[p++] ?? 0;
    if ((n & 0x80) !== 0) n = ((n & 0x7f) << 8) | (b[p++] ?? 0);
    return n;
  };
  readLen(); // utf16 length, unused: the byte length below is authoritative
  const byteLen = readLen();
  if (p + byteLen > b.length) throw resErr("utf8 string ran past end of pool", p, ErrorCode.E_TRUNCATED);
  return new TextDecoder("utf-8").decode(b.subarray(p, p + byteLen));
}

/** A `Res_value` (8 bytes): size, res0, dataType, data. */
export interface ResValue {
  readonly dataType: number;
  readonly data: number;
}

export const TYPE_NULL = 0x00;
export const TYPE_REFERENCE = 0x01;
export const TYPE_ATTRIBUTE = 0x02;
export const TYPE_STRING = 0x03;
export const TYPE_FLOAT = 0x04;
export const TYPE_INT_DEC = 0x10;
export const TYPE_INT_HEX = 0x11;
export const TYPE_INT_BOOLEAN = 0x12;

export function readResValue(b: Uint8Array, o: number): ResValue {
  return { dataType: b[o + 3] ?? 0, data: ru32(b, o + 4) };
}
