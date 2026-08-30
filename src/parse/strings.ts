// docs/specs/01-parser.md §3.3, §5 — string table: kinds (RLE), small/overflow
// entries, storage decode. docs/HBC-FORMAT.md §5.
//
// M1 review Finding 4 (memory): a 50.8MB real bundle (327,121 strings) grew RSS by
// ~4x during parsing; profiling isolated ~61MB of that to eagerly building one boxed
// `StringEntry` object per string here. Fixed by resolving into parallel typed
// arrays (structure-of-arrays) instead of one object per string — INV-12's
// bounds-check still runs eagerly for every string (spec 01 "eager for tables"), it
// just no longer allocates a JS object to do it. `entry(id)` now builds one small
// object on demand per call, matching `get()`'s existing on-demand-decode pattern.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import { decodeAscii, decodeUtf16 } from "../util/text.ts";
import type { HbcHeader, SectionMap, StringEntry, StringKind, StringTable } from "./types.ts";

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

  // --- smallStringTable, decoded straight into parallel typed arrays (no per-string
  // object) ---
  const smallSpan = sections.span("smallStringTable");
  const rawIsUtf16 = new Uint8Array(stringCount);
  const rawOffset = new Uint32Array(stringCount); // 23-bit field: storage offset, or overflow index
  const rawLength = new Uint8Array(stringCount); // 8-bit field: char length, or 0xff sentinel
  {
    const r = new BinaryReader(bytes.subarray(smallSpan.offset, smallSpan.offset + smallSpan.size), "smallStringTable");
    for (let i = 0; i < stringCount; i++) {
      const datum = r.u32();
      rawIsUtf16[i] = datum & 0x1;
      rawOffset[i] = (datum >>> 1) & 0x7fffff; // bits 1..23
      rawLength[i] = (datum >>> 24) & 0xff; // bits 24..31
    }
  }

  // --- overflowStringTable ---
  const overflowSpan = sections.span("overflowStringTable");
  const overflowCount = header.overflowStringCount;
  const ovOffset = new Uint32Array(overflowCount);
  const ovLength = new Uint32Array(overflowCount);
  {
    const r = new BinaryReader(bytes.subarray(overflowSpan.offset, overflowSpan.offset + overflowSpan.size), "overflowStringTable");
    for (let i = 0; i < overflowCount; i++) {
      ovOffset[i] = r.u32();
      ovLength[i] = r.u32();
    }
  }

  const storageSpan = sections.span("stringStorage");
  const storage = bytes.subarray(storageSpan.offset, storageSpan.offset + storageSpan.size);

  // Resolve + validate (INV-12/INV-13) every entry eagerly, as spec 01 §2 requires
  // ("eager for tables") — but into typed arrays, not one StringEntry object each.
  const resolvedOffset = new Uint32Array(stringCount);
  const resolvedLength = new Uint32Array(stringCount);
  const overflowedFlag = new Uint8Array(stringCount);
  for (let id = 0; id < stringCount; id++) {
    const overflowed = rawLength[id] === 0xff;
    let storageOffset: number;
    let length: number;
    if (overflowed) {
      const idx = rawOffset[id]!;
      if (idx >= overflowCount) {
        throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `string ${id} overflow index ${idx} out of range [0, ${overflowCount})`, {
          section: "overflowStringTable",
        });
      }
      storageOffset = ovOffset[idx]!;
      length = ovLength[idx]!;
    } else {
      storageOffset = rawOffset[id]!;
      length = rawLength[id]!;
    }
    const byteLength = length * (rawIsUtf16[id] === 1 ? 2 : 1);
    if (storageOffset + byteLength > storage.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `string ${id} [${storageOffset}, ${storageOffset + byteLength}) outside stringStorage (${storage.length})`, {
        section: "stringStorage",
      });
    }
    resolvedOffset[id] = storageOffset;
    resolvedLength[id] = length;
    overflowedFlag[id] = overflowed ? 1 : 0;
  }

  const cache = new Map<number, string>();

  function checkId(id: number): void {
    if (!Number.isInteger(id) || id < 0 || id >= stringCount) {
      throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `string id ${id} out of range [0, ${stringCount})`, {});
    }
  }

  function makeEntry(id: number): StringEntry {
    return {
      id,
      kind: kinds[id] === 1 ? "Identifier" : "String",
      isUTF16: rawIsUtf16[id] === 1,
      storageOffset: resolvedOffset[id]!,
      length: resolvedLength[id]!,
      overflowed: overflowedFlag[id] === 1,
    };
  }

  return {
    count: stringCount,
    identifierCount,
    storage,
    entry(id: number): StringEntry {
      checkId(id);
      return makeEntry(id);
    },
    get(id: number): string {
      checkId(id);
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const offset = resolvedOffset[id]!;
      const length = resolvedLength[id]!;
      const decoded = rawIsUtf16[id] === 1 ? decodeUtf16(storage, offset, length) : decodeAscii(storage, offset, length);
      cache.set(id, decoded);
      return decoded;
    },
    kind(id: number): StringKind {
      checkId(id);
      return kinds[id] === 1 ? "Identifier" : "String";
    },
    identifierHash(id: number): number | undefined {
      checkId(id);
      const ord = identifierOrdinal[id]!;
      if (ord < 0) return undefined;
      return identifierHashes[ord];
    },
  };
}
