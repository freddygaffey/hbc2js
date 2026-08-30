// docs/specs/01-parser.md §3.7, §4; docs/HBC-FORMAT.md §4, §10.
// Per-function DebugOffsets (part of the info block) and the standalone debug-info
// section header + filename table + file regions. The delta stream itself is exposed
// raw and NOT decoded in M1 (spec 01 §1, O-5).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import { decodeAscii, decodeUtf16 } from "../util/text.ts";
import type { DebugFileRegion, DebugInfo, DebugOffsets, LayoutClass, SectionMap } from "./types.ts";

const NONE = 0xffffffff;
function sentinel(v: number): number | null {
  return v === NONE ? null : v;
}

/** Reads the per-function DebugOffsets sub-section. `size` is 4 (v>=97), 8 (v<=83)
 *  or 12 (v84-96) — docs/HBC-FORMAT.md §4. Advances the reader past it. */
export function readDebugOffsets(r: BinaryReader, size: 4 | 8 | 12): DebugOffsets {
  if (size === 4) {
    const sourceLocations = r.u32();
    return { sourceLocations: sentinel(sourceLocations), lexicalData: null, scopeDescData: null, textifiedCallees: null };
  }
  if (size === 8) {
    const sourceLocations = r.u32();
    const lexicalData = r.u32();
    return { sourceLocations: sentinel(sourceLocations), lexicalData: sentinel(lexicalData), scopeDescData: null, textifiedCallees: null };
  }
  const sourceLocations = r.u32();
  const scopeDescData = r.u32();
  const textifiedCallees = r.u32();
  return { sourceLocations: sentinel(sourceLocations), lexicalData: null, scopeDescData: sentinel(scopeDescData), textifiedCallees: sentinel(textifiedCallees) };
}

/** The file-level `DebugInfoHeader` (include/hermes/BCGen/HBC/BytecodeFileFormat.h)
 *  has changed shape THREE times, on a *different* version boundary than the
 *  per-function `DebugOffsets` struct above — verified by fetching the struct
 *  directly from the pinned commits (not documented in docs/HBC-FORMAT.md §10,
 *  which only shows the final/current shape; see docs/AGENT-LOG.md for the
 *  byte-level derivation against `hermes-dec-sample/v84.hbc`):
 *    - class A/B (<=86, commit c2cd9e38 for v84): 5 fields, ending in a single
 *      `lexicalDataOffset` — `{filenameCount, filenameStorageSize, fileRegionCount,
 *      lexicalDataOffset, debugDataSize}`.
 *    - class C (87-96, commit 1c717488 for v94): 7 fields — the `lexicalDataOffset`
 *      field is replaced by three: `scopeDescDataOffset`, `textifiedCalleeOffset`,
 *      `stringTableOffset`.
 *    - class D/E (>=97, commit 913d31acd10a for v99-mar2026): back down to 4 fields
 *      — `{filenameCount, filenameStorageSize, fileRegionCount, debugDataSize}`,
 *      matching the per-function struct's own shrink at the static_h fork. */
type DebugHeaderShape = "legacy" | "classic" | "static";
function debugHeaderShape(layoutClass: LayoutClass): DebugHeaderShape {
  if (layoutClass === "A" || layoutClass === "B") return "legacy";
  if (layoutClass === "C") return "classic";
  return "static";
}

/** docs/HBC-FORMAT.md §10 — header + filename table + file regions. `null` when the
 *  file has no debug info (`header.debugInfoOffset === 0`). */
export function parseDebugInfo(bytes: Uint8Array, sections: SectionMap, debugInfoOffset: number, layoutClass: LayoutClass): DebugInfo | null {
  if (debugInfoOffset === 0) return null;

  const footer = sections.span("footer");
  const r = new BinaryReader(bytes.subarray(debugInfoOffset, footer.offset), "debugInfo");
  const shape = debugHeaderShape(layoutClass);

  const filenameCount = r.u32();
  const filenameStorageSize = r.u32();
  const fileRegionCount = r.u32();
  let scopeDescDataOffset: number | null = null;
  let textifiedCalleeOffset: number | null = null;
  let stringTableOffset: number | null = null;
  if (shape === "legacy") {
    scopeDescDataOffset = sentinel(r.u32()); // really `lexicalDataOffset`, exposed via the same field
  } else if (shape === "classic") {
    scopeDescDataOffset = sentinel(r.u32());
    textifiedCalleeOffset = sentinel(r.u32());
    stringTableOffset = sentinel(r.u32());
  }
  const debugDataSize = r.u32();

  // StringTableEntry (include/hermes/Support/StringTableEntry.h): uint32 offset,
  // uint32 length (top bit = isUTF16).
  const UTF16_MASK = 0x80000000;
  r.require(filenameCount * 8); // guards new Array(filenameCount) against a fuzzed huge count
  const filenameEntries: { offset: number; length: number; isUTF16: boolean }[] = new Array(filenameCount);
  for (let i = 0; i < filenameCount; i++) {
    const offset = r.u32();
    const lengthField = r.u32();
    filenameEntries[i] = { offset, length: lengthField & ~UTF16_MASK, isUTF16: (lengthField & UTF16_MASK) !== 0 };
  }
  const filenameStorage = r.bytes(filenameStorageSize);
  // A corrupt/fuzzed length or offset must not reach String.fromCharCode with an
  // absurd count (native RangeError) — bounds-check exactly like the main string
  // table's INV-12, fatal E_SECTION_OVERRUN on violation.
  const filenames = filenameEntries.map((e, i) => {
    const byteLength = e.length * (e.isUTF16 ? 2 : 1);
    if (e.offset < 0 || byteLength < 0 || e.offset + byteLength > filenameStorage.length) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `debug filename ${i} [${e.offset}, ${e.offset + byteLength}) outside filenameStorage (${filenameStorage.length})`, {
        section: "debugInfo",
      });
    }
    return e.isUTF16 ? decodeUtf16(filenameStorage, e.offset, e.length) : decodeAscii(filenameStorage, e.offset, e.length);
  });

  r.require(fileRegionCount * 12); // guards new Array(fileRegionCount)
  const fileRegions: DebugFileRegion[] = new Array(fileRegionCount);
  for (let i = 0; i < fileRegionCount; i++) {
    const fromAddress = r.u32();
    const filenameId = r.u32();
    const sourceMappingUrlId = r.u32();
    fileRegions[i] = { fromAddress, filenameId, sourceMappingUrlId };
  }

  const data = r.bytes(debugDataSize);

  return {
    offset: debugInfoOffset,
    filenameCount,
    filenameStorageSize,
    fileRegionCount,
    scopeDescDataOffset,
    textifiedCalleeOffset,
    stringTableOffset,
    debugDataSize,
    filenames,
    fileRegions,
    data,
  };
}
