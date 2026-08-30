// docs/specs/01-parser.md §4 (exception handler table); docs/HBC-FORMAT.md §4, §4.3.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { ExceptionHandler } from "./types.ts";

/** Reads `uint32 count` then `count * {start,end,target}` (each uint32, function-
 *  relative) starting at the reader's current position. Advances the reader past the
 *  table (which the caller must then 4-byte-align). */
export function readExceptionTable(r: BinaryReader, bytecodeSizeInBytes: number, functionIndex: number): readonly ExceptionHandler[] {
  const count = r.u32();
  // INV-15: count * 12 (+ the 4-byte count field already consumed) must fit before
  // the next info sub-section — enforced here as "the bytes must physically exist",
  // which also protects `new Array(count)` from a fuzzed/corrupt huge count (a raw
  // RangeError, not Hbc2jsError, would otherwise escape).
  r.require(count * 12);
  const handlers: ExceptionHandler[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const start = r.u32();
    const end = r.u32();
    const target = r.u32();
    if (!(start < end) || end > bytecodeSizeInBytes || target >= bytecodeSizeInBytes) {
      throw new Hbc2jsError(ErrorCode.E_BAD_HANDLER, `handler ${i} of function ${functionIndex}: start=${start} end=${end} target=${target} (size=${bytecodeSizeInBytes})`, {
        functionIndex,
        section: "functionInfo",
      });
    }
    handlers[i] = { start, end, target };
  }
  return handlers;
}
