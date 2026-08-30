// docs/specs/01-parser.md §3.6; docs/HBC-FORMAT.md §8.
// We never decode regExpStorage's compiled bytecode — the pattern/flags are always
// available as string-table ids on the CreateRegExp instruction (spec 02).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { RegExpEntry, SectionMap } from "./types.ts";

export function parseRegExpTable(bytes: Uint8Array, sections: SectionMap, regExpCount: number): readonly RegExpEntry[] {
  const tableSpan = sections.span("regExpTable");
  const storageSpan = sections.span("regExpStorage");
  const storage = bytes.subarray(storageSpan.offset, storageSpan.offset + storageSpan.size);
  const r = new BinaryReader(bytes.subarray(tableSpan.offset, tableSpan.offset + tableSpan.size), "regExpTable");

  const entries: RegExpEntry[] = new Array(regExpCount);
  for (let i = 0; i < regExpCount; i++) {
    const offset = r.u32();
    const length = r.u32();
    if (offset < 0 || length < 0 || offset + length > storage.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `regexp ${i} [${offset}, ${offset + length}) outside regExpStorage (${storage.length})`, {
        section: "regExpStorage",
      });
    }
    entries[i] = { index: i, offset, length, bytes: storage.subarray(offset, offset + length) };
  }
  return entries;
}
