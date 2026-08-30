// docs/specs/01-parser.md §7.2 — bounds-checked cursor over a Uint8Array.
// This is the ONE place in the codebase allowed to read out of bounds; it throws
// E_SECTION_OVERRUN instead. All higher-level code goes through this.
import { ErrorCode, Hbc2jsError } from "../errors.ts";

export class BinaryReader {
  offset: number;
  readonly length: number;
  private readonly bytesArr: Uint8Array;
  private readonly view: DataView;
  private readonly section: string | undefined;

  constructor(bytes: Uint8Array, section?: string) {
    this.bytesArr = bytes;
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
    this.section = section;
  }

  /** Throws E_SECTION_OVERRUN with {offset, section} if fewer than n bytes remain. */
  require(n: number): void {
    if (n < 0 || this.offset + n > this.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `need ${n} bytes, only ${this.length - this.offset} remain`, {
        offset: this.offset,
        ...(this.section !== undefined ? { section: this.section } : {}),
      });
    }
  }

  u8(): number {
    this.require(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    this.require(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    this.require(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.require(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i32(): number {
    this.require(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.require(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  u64(): bigint {
    this.require(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** View, not copy. */
  bytes(n: number): Uint8Array {
    this.require(n);
    const v = this.bytesArr.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }

  skip(n: number): void {
    this.require(n);
    this.offset += n;
  }

  align(n: number): void {
    const rem = this.offset % n;
    if (rem !== 0) this.skip(n - rem);
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `seek target ${offset} out of range [0, ${this.length}]`, {
        offset,
        ...(this.section !== undefined ? { section: this.section } : {}),
      });
    }
    this.offset = offset;
  }

  /** Peek forms with an explicit offset, for probing without moving the cursor. */
  peekU32(at: number): number {
    if (at < 0 || at + 4 > this.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `peekU32 at ${at} out of range`, {
        offset: at,
        ...(this.section !== undefined ? { section: this.section } : {}),
      });
    }
    return this.view.getUint32(at, true);
  }

  peekU8(at: number): number {
    if (at < 0 || at + 1 > this.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `peekU8 at ${at} out of range`, {
        offset: at,
        ...(this.section !== undefined ? { section: this.section } : {}),
      });
    }
    return this.view.getUint8(at);
  }
}

/** Standalone bounds-checked reads at an explicit offset, for one-off probing
 *  (layout candidates) without constructing a full reader. Same overrun behaviour. */
export function readU32At(bytes: Uint8Array, offset: number, section?: string): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `u32 read at ${offset} out of range`, {
      offset,
      ...(section !== undefined ? { section } : {}),
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, true);
}

export function readU8At(bytes: Uint8Array, offset: number, section?: string): number {
  if (offset < 0 || offset + 1 > bytes.length) {
    throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `u8 read at ${offset} out of range`, {
      offset,
      ...(section !== undefined ? { section } : {}),
    });
  }
  return bytes[offset]!;
}
