// docs/specs/01-parser.md §3.6; docs/HBC-FORMAT.md §7.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { BigIntEntry, SectionMap } from "./types.ts";

/** Two's-complement little-endian magnitude; sign is the top bit of the last byte.
 *  Empty storage decodes to 0n. docs/specs/01-parser.md §3.6. */
export function decodeBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  if (bytes.length > 0 && (bytes[bytes.length - 1]! & 0x80) !== 0) {
    n -= 1n << BigInt(8 * bytes.length);
  }
  return n;
}

export function parseBigIntTable(bytes: Uint8Array, sections: SectionMap, bigIntCount: number): readonly BigIntEntry[] {
  const tableSpan = sections.span("bigIntTable");
  const storageSpan = sections.span("bigIntStorage");
  const storage = bytes.subarray(storageSpan.offset, storageSpan.offset + storageSpan.size);
  const r = new BinaryReader(bytes.subarray(tableSpan.offset, tableSpan.offset + tableSpan.size), "bigIntTable");

  const entries: BigIntEntry[] = new Array(bigIntCount);
  for (let i = 0; i < bigIntCount; i++) {
    const offset = r.u32();
    const length = r.u32();
    if (offset < 0 || length < 0 || offset + length > storage.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `bigint ${i} [${offset}, ${offset + length}) outside bigIntStorage (${storage.length})`, {
        section: "bigIntStorage",
      });
    }
    const view = storage.subarray(offset, offset + length);
    let cached: bigint | undefined;
    entries[i] = {
      index: i,
      offset,
      length,
      bytes: view,
      value(): bigint {
        if (cached === undefined) cached = decodeBigInt(view);
        return cached;
      },
    };
  }
  return entries;
}
