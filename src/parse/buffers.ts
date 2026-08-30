// docs/specs/01-parser.md §3.5; docs/HBC-FORMAT.md §6.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { LiteralRun, ObjectShape, SectionMap, SerializedLiteral } from "./types.ts";

/** docs/HBC-FORMAT.md §6.2 — v>=97 object shape table, `{uint32 keyBufferOffset;
 *  uint32 numProps;}` per entry. Empty for v<=96. */
export function parseShapeTable(bytes: Uint8Array, sections: SectionMap, count: number, objKeyBufferLength: number): readonly ObjectShape[] {
  const span = sections.span("objShapeTable");
  const r = new BinaryReader(bytes.subarray(span.offset, span.offset + span.size), "objShapeTable");
  const shapes: ObjectShape[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const keyBufferOffset = r.u32();
    const numProps = r.u32();
    if (keyBufferOffset >= objKeyBufferLength && !(keyBufferOffset === 0 && objKeyBufferLength === 0)) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `shape ${i}.keyBufferOffset=${keyBufferOffset} >= objKeyBuffer.length ${objKeyBufferLength}`, {
        section: "objShapeTable",
      });
    }
    shapes[i] = { index: i, keyBufferOffset, numProps };
  }
  return shapes;
}

const TAG_NAMES = ["null", "true", "false", "number", "longString", "shortString", "byteString", "integer"] as const;

/** Read one run header at `offset`. §6.3: short form `0ttt llll` (1 byte, len<=15);
 *  long form `1ttt llll llllllll` (2 bytes, len = low 12 bits, <=4095). */
export function readLiteralRun(buf: Uint8Array, offset: number, version?: number): LiteralRun {
  if (offset < 0 || offset >= buf.length) {
    throw new Hbc2jsError(ErrorCode.E_BAD_LITERAL_TAG, `literal run header at ${offset} is out of bounds`, { offset, section: "literalValueBuffer" });
  }
  const first = buf[offset]!;
  const isLong = (first & 0x80) !== 0;
  const tag = (first >>> 4) & 0x7;
  let count: number;
  let headerBytes: number;
  if (isLong) {
    if (offset + 1 >= buf.length) {
      throw new Hbc2jsError(ErrorCode.E_BAD_LITERAL_TAG, `long-form literal run header at ${offset} truncated`, { offset, section: "literalValueBuffer" });
    }
    const second = buf[offset + 1]!;
    count = ((first & 0x0f) << 8) | second;
    headerBytes = 2;
  } else {
    count = first & 0x0f;
    headerBytes = 1;
  }
  const payloadWidth = payloadBytes(tag, version);
  const byteLength = headerBytes + payloadWidth * count;
  if (offset + byteLength > buf.length) {
    throw new Hbc2jsError(ErrorCode.E_BAD_LITERAL_TAG, `literal run at ${offset} (tag ${TAG_NAMES[tag]}, count ${count}) overruns buffer`, {
      offset,
      section: "literalValueBuffer",
    });
  }
  return { offset, tag, count, byteLength };
}

// Null,True,False,Number,LongString,ShortString,ByteString,Integer.
//
// **Tag 6 is era-dependent.** At v≤96 it is `ByteString` (one payload byte, a
// uint8 string id); from v≥97 Hermes renamed it `UndefinedTag` and it carries
// NO payload (`SerializedLiteralGenerator.h` at the vendored 639e5d6/913d31a
// pins; docs/HBC-FORMAT.md §6.3). `readRunHeader`/`readLiterals` take an
// optional `version` for that reason; omitting it means the v≤96 reading, which
// is what every pre-existing caller wants. `src/emit/literals.ts` has its own
// era-aware reader and does not go through here.
const PAYLOAD_BYTES: readonly number[] = [0, 0, 0, 8, 4, 2, 1, 4];
const PAYLOAD_BYTES_V97: readonly number[] = [0, 0, 0, 8, 4, 2, 0, 4];

/** Payload width per tag for a given bytecode version (undefined = v≤96). */
function payloadBytes(tag: number, version: number | undefined): number {
  return (version !== undefined && version >= 97 ? PAYLOAD_BYTES_V97 : PAYLOAD_BYTES)[tag]!;
}

function readOneValue(buf: Uint8Array, view: DataView, tag: number, at: number, version?: number): SerializedLiteral {
  switch (tag) {
    case 0:
      return { kind: "null" };
    case 1:
      return { kind: "boolean", value: true };
    case 2:
      return { kind: "boolean", value: false };
    case 3:
      return { kind: "number", value: view.getFloat64(at, true) };
    case 4:
      return { kind: "string", stringId: view.getUint32(at, true) };
    case 5:
      return { kind: "string", stringId: view.getUint16(at, true) };
    case 6:
      // v≥97: `UndefinedTag`, no payload. v≤96: `ByteString`, one payload byte.
      if (version !== undefined && version >= 97) return { kind: "undefined" };
      return { kind: "string", stringId: buf[at]! };
    case 7:
      return { kind: "integer", value: view.getInt32(at, true) };
    default:
      throw new Hbc2jsError(ErrorCode.E_BAD_LITERAL_TAG, `unknown literal tag ${tag}`, { offset: at, section: "literalValueBuffer" });
  }
}

/** Read exactly `count` values starting at `offset`, consuming as many runs as
 *  needed. `count` comes from the instruction operand, not the buffer. */
export function readLiterals(buf: Uint8Array, offset: number, count: number, version?: number): { values: readonly SerializedLiteral[]; nextOffset: number } {
  const values: SerializedLiteral[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = offset;
  while (values.length < count) {
    const run = readLiteralRun(buf, o, version);
    const width = payloadBytes(run.tag, version);
    const payloadStart = o + (run.byteLength - width * run.count);
    const need = count - values.length;
    const take = Math.min(need, run.count);
    for (let i = 0; i < take; i++) {
      values.push(readOneValue(buf, view, run.tag, payloadStart + i * width, version));
    }
    if (take < run.count) {
      // Partial consumption of a run: the next read starts mid-run. Compute the
      // resulting offset as if the run had only `take` elements.
      o = payloadStart + take * width;
    } else {
      o = o + run.byteLength;
    }
  }
  return { values, nextOffset: o };
}
