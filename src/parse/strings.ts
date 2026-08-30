// docs/specs/01-parser.md §3.3, §5 — string table: kinds (RLE), small/overflow
// entries, storage decode. docs/HBC-FORMAT.md §5.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import { decodeAscii, decodeUtf16 } from "../util/text.ts";
import type { HbcHeader, SectionMap, StringEntry, StringKind, StringTable } from "./types.ts";

interface SmallEntry {
  readonly isUTF16: boolean;
  readonly offset: number; // raw field: byte offset into storage, OR overflow index
  readonly length: number; // raw field: 0..255; 255 == overflowed
}

export function parseStringTable(bytes: Uint8Array, header: HbcHeader, sections: SectionMap): StringTable {
  const stringCount = header.stringCount;
  const identifierCount = header.identifierCount;

  // --- string kinds (RLE) ---
  const kindsSpan = sections.span("stringKinds");
  const kinds = new Uint8Array(stringCount); // 0 = String, 1 = Identifier
  {
    const r = new BinaryReader(bytes.subarray(kindsSpan.offset, kindsSpan.offset + kindsSpan.size), "stringKinds");
    let filled = 0;
    for (let i = 0; i < header.stringKindCount; i++) {
      const datum = r.u32();
      const kind = datum >>> 31;
      const count = datum & 0x7fffffff;
      if (filled + count > stringCount) {
        throw new Hbc2jsError(ErrorCode.E_SECTION_MISMATCH, `stringKinds run overruns stringCount (${filled}+${count} > ${stringCount})`, {
          section: "stringKinds",
        });
      }
      kinds.fill(kind, filled, filled + count);
      filled += count;
    }
    if (filled !== stringCount) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_MISMATCH, `stringKinds runs sum to ${filled}, expected stringCount ${stringCount}`, {
        section: "stringKinds",
      });
    }
  }
  let identifierTotal = 0;
  for (let i = 0; i < stringCount; i++) if (kinds[i] === 1) identifierTotal++;
  if (identifierTotal !== identifierCount) {
    throw new Hbc2jsError(ErrorCode.E_SECTION_MISMATCH, `stringKinds has ${identifierTotal} identifiers, header says ${identifierCount}`, {
      section: "stringKinds",
    });
  }
  // Identifier ordinal per string id (only meaningful where kinds[id] === 1).
  const identifierOrdinal = new Int32Array(stringCount).fill(-1);
  {
    let ordinal = 0;
    for (let i = 0; i < stringCount; i++) {
      if (kinds[i] === 1) identifierOrdinal[i] = ordinal++;
    }
  }

  // --- identifierHashes ---
  const hashesSpan = sections.span("identifierHashes");
  const identifierHashes = new Uint32Array(identifierCount);
  {
    const r = new BinaryReader(bytes.subarray(hashesSpan.offset, hashesSpan.offset + hashesSpan.size), "identifierHashes");
    for (let i = 0; i < identifierCount; i++) identifierHashes[i] = r.u32();
  }

  // --- smallStringTable ---
  const smallSpan = sections.span("smallStringTable");
  const smallEntries: SmallEntry[] = new Array(stringCount);
  {
    const r = new BinaryReader(bytes.subarray(smallSpan.offset, smallSpan.offset + smallSpan.size), "smallStringTable");
    for (let i = 0; i < stringCount; i++) {
      const datum = r.u32();
      const isUTF16 = (datum & 0x1) !== 0;
      const offset = (datum >>> 1) & 0x7fffff; // bits 1..23 (23 bits)
      const length = (datum >>> 24) & 0xff; // bits 24..31 (8 bits)
      smallEntries[i] = { isUTF16, offset, length };
    }
  }

  // --- overflowStringTable ---
  const overflowSpan = sections.span("overflowStringTable");
  const overflowCount = header.overflowStringCount;
  const overflowEntries: { offset: number; length: number }[] = new Array(overflowCount);
  {
    const r = new BinaryReader(bytes.subarray(overflowSpan.offset, overflowSpan.offset + overflowSpan.size), "overflowStringTable");
    for (let i = 0; i < overflowCount; i++) {
      const offset = r.u32();
      const length = r.u32();
      overflowEntries[i] = { offset, length };
    }
  }

  const storageSpan = sections.span("stringStorage");
  const storage = bytes.subarray(storageSpan.offset, storageSpan.offset + storageSpan.size);

  // Resolve every entry once (id, kind, isUTF16, storageOffset, length in characters, overflowed).
  const resolved: StringEntry[] = new Array(stringCount);
  for (let id = 0; id < stringCount; id++) {
    const small = smallEntries[id]!;
    const overflowed = small.length === 0xff;
    let storageOffset: number;
    let length: number;
    if (overflowed) {
      const idx = small.offset;
      if (idx < 0 || idx >= overflowCount) {
        throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `string ${id} overflow index ${idx} out of range [0, ${overflowCount})`, {
          section: "overflowStringTable",
        });
      }
      const ov = overflowEntries[idx]!;
      storageOffset = ov.offset;
      length = ov.length;
    } else {
      storageOffset = small.offset;
      length = small.length;
    }
    const byteLength = length * (small.isUTF16 ? 2 : 1);
    if (storageOffset < 0 || byteLength < 0 || storageOffset + byteLength > storage.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `string ${id} [${storageOffset}, ${storageOffset + byteLength}) outside stringStorage (${storage.length})`, {
        section: "stringStorage",
      });
    }
    resolved[id] = {
      id,
      kind: kinds[id] === 1 ? "Identifier" : "String",
      isUTF16: small.isUTF16,
      storageOffset,
      length,
      overflowed,
    };
  }

  const cache = new Map<number, string>();

  function checkId(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= stringCount) {
      throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `string id ${id} out of range [0, ${stringCount})`, {});
    }
  }

  return {
    count: stringCount,
    identifierCount,
    storage,
    entry(id: number): StringEntry {
      checkId(id);
      return resolved[id]!;
    },
    get(id: number): string {
      checkId(id);
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const e = resolved[id]!;
      const decoded = e.isUTF16 ? decodeUtf16(storage, e.storageOffset, e.length) : decodeAscii(storage, e.storageOffset, e.length);
      cache.set(id, decoded);
      return decoded;
    },
    kind(id: number): StringKind {
      checkId(id);
      return resolved[id]!.kind;
    },
    identifierHash(id: number): number | undefined {
      checkId(id);
      const ord = identifierOrdinal[id]!;
      if (ord < 0) return undefined;
      return identifierHashes[ord];
    },
  };
}
