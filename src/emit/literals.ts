// docs/specs/05-emitter.md §5 — strings, regexps, BigInt and the literal buffers.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { HbcModule, SerializedLiteral } from "../parse/types.ts";
import type { Expr, ObjectProp } from "./ast.ts";
import { lit, renderNumber } from "./ast.ts";
import { isSafePropertyName, quote } from "./names.ts";

export function stringLiteral(mod: HbcModule, id: number): Expr {
  return lit(quote(mod.strings.get(id)));
}

export function bigIntLiteral(mod: HbcModule, index: number, functionIndex: number, offset: number): Expr {
  const entry = mod.bigInts[index];
  if (entry === undefined) {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `bigint index ${index} out of range`, { functionIndex, offset, section: "emit/literals" });
  }
  return lit(`${entry.value().toString()}n`);
}

// Null, True, False, Number, LongString, ShortString, ByteString, Integer.
//
// **ByteString carries no payload.** docs/HBC-FORMAT.md §6.3 lists one byte for
// it, but no `hermesc` output in the corpus ever uses it for a real string --
// short ids go through ShortString (`05-for-in-object` v99 stores string id 7 as
// `51 07 00`). Tag 6 is the generator's marker for the value §6.3 says has no tag
// of its own: `undefined`. Reading it with a payload byte decodes
// `24-generator-return-throw` v99's "already finished" result as
// `{value: "next", done: 1}` instead of `{value: undefined, done: true}`, and in
// `47-typeof-instanceof-in` v99 it swallows the byte that is actually the *next*
// buffer entry's run header. With no payload every offset in every fixture still
// lands on a run boundary, and both objects decode to what the source says.
const PAYLOAD_BYTES_V97: readonly number[] = [0, 0, 0, 8, 4, 2, 0, 4];
const PAYLOAD_BYTES_LEGACY: readonly number[] = [0, 0, 0, 8, 4, 2, 1, 4];

/**
 * `undefined` has no tag in the serialized-literal encoding: HBC-FORMAT §6.3
 * says the generator writes it as a *string* tag, and spec 05 §5 adds "assert
 * the resulting string id is in range". Measured on
 * `47-typeof-instanceof-in` v99 (`{ a: 1, b: undefined }`): the second value is
 * `ByteString` with id 114 in a module that has 27 strings, and its payload byte
 * is shared with the *next* buffer entry's run header — Hermes's buffer
 * allocator overlaps them precisely because the byte is never meaningful. So an
 * out-of-range string id, and a run that runs off the end of the buffer, both
 * mean `undefined`, and neither is an error.
 */
function readValuesTolerant(buf: Uint8Array, offset: number, count: number, version: number): (SerializedLiteral | null)[] {
  const payloadBytes = version >= 97 ? PAYLOAD_BYTES_V97 : PAYLOAD_BYTES_LEGACY;
  const out: (SerializedLiteral | null)[] = [];
  let o = offset;
  const bail = (): (SerializedLiteral | null)[] => {
    while (out.length < count) out.push(null);
    return out;
  };
  while (out.length < count) {
    if (o < 0 || o >= buf.length) return bail();
    const first = buf[o]!;
    const isLong = (first & 0x80) !== 0;
    const tag = (first >>> 4) & 0x7;
    let runCount: number;
    let header: number;
    if (isLong) {
      if (o + 1 >= buf.length) return bail();
      runCount = ((first & 0x0f) << 8) | buf[o + 1]!;
      header = 2;
    } else {
      runCount = first & 0x0f;
      header = 1;
    }
    const width = payloadBytes[tag]!;
    const payloadStart = o + header;
    const take = Math.min(count - out.length, runCount);
    if (payloadStart + take * width > buf.length) return bail();
    for (let i = 0; i < take; i++) out.push(readOne(buf, tag, payloadStart + i * width, width));
    o = take < runCount ? payloadStart + take * width : payloadStart + runCount * width;
  }
  return out;
}

function readOne(buf: Uint8Array, tag: number, at: number, width: number): SerializedLiteral | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
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
      // v>=97: the generator's marker for `undefined`; v<=96: a 1-byte string id.
      return width === 0 ? null : { kind: "string", stringId: buf[at]! };
    case 7:
      return { kind: "integer", value: view.getInt32(at, true) };
    default:
      return null;
  }
}

function literalExpr(mod: HbcModule, v: SerializedLiteral | null): Expr {
  if (v === null) return lit("undefined");
  if (v.kind === "string" && (v.stringId < 0 || v.stringId >= mod.strings.count)) return lit("undefined");
  switch (v.kind) {
    case "null":
      return lit("null");
    case "boolean":
      return lit(v.value ? "true" : "false");
    case "number":
      return lit(renderNumber(v.value));
    case "integer":
      return lit(renderNumber(v.value));
    case "string":
      return stringLiteral(mod, v.stringId);
    case "undefined":
      // Only reachable via `src/parse/buffers.ts`'s version-aware reader; this
      // module's own `readValuesTolerant` signals it with `null` (above).
      return lit("undefined");
  }
}

/** `NewArrayWithBuffer[Long] dst, sizeHint, numElems, bufIdx`. */
export function arrayFromBuffer(mod: HbcModule, offset: number, count: number): Expr {
  const values = readValuesTolerant(mod.literalValueBuffer, offset, count, mod.header.version);
  return { k: "array", elements: values.map((v) => literalExpr(mod, v)) };
}

/**
 * Object keys, in buffer order. Property order is observable in JS
 * (`Object.keys`, `for…in`, `JSON.stringify`) and the equivalence checker
 * compares it (EM-06), so the order here is the buffer's, never sorted.
 */
export function objectKeys(mod: HbcModule, keyBufferOffset: number, numProps: number, functionIndex: number, insnOffset: number): string[] {
  const values = readValuesTolerant(mod.objKeyBuffer, keyBufferOffset, numProps, mod.header.version);
  return values.map((v) => {
    if (v === null) throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `object key buffer at ${keyBufferOffset} does not hold ${numProps} keys`, { functionIndex, offset: insnOffset, section: "emit/literals" });
    if (v.kind === "string") return mod.strings.get(v.stringId);
    if (v.kind === "integer" || v.kind === "number") return renderNumber(v.value);
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `object key literal of kind ${v.kind} is not a property name`, { functionIndex, offset: insnOffset, section: "emit/literals" });
  });
}

/**
 * At v<=96 the values live in `objValueBuffer`; at v>=97 that section was
 * replaced by the object shape table and the values moved into the unified
 * `literalValueBuffer` (docs/HBC-FORMAT.md §1 layout classes D/E). Measured:
 * `05-for-in-object` v99 has `objValueBuffer` empty and a 17-byte
 * `literalValueBuffer`, with `NewObjectWithBuffer sh0, lit@0` and `sh1, lit@4`.
 */
export function objectFromBuffers(mod: HbcModule, keys: readonly string[], valueOffset: number, functionIndex: number, insnOffset: number): Expr {
  const buffer = mod.header.version >= 97 ? mod.literalValueBuffer : mod.objValueBuffer;
  const values = readValuesTolerant(buffer, valueOffset, keys.length, mod.header.version);
  const props: ObjectProp[] = keys.map((key, i) => {
    const value = literalExpr(mod, values[i]!);
    return isSafePropertyName(key) ? { key, computed: false, value } : { key: quote(key), computed: true, value };
  });
  void functionIndex;
  void insnOffset;
  return { k: "object", props };
}

/**
 * §5 — `CreateRegExp dst, patternStrId, flagsStrId, tableIdx` becomes
 * `new RegExp(pattern, flags)`. `regExpStorage` is never decoded: the source
 * pattern is right there in the string table. A `/…/flags` literal is a stage-B
 * pass (it needs escaping analysis for unescaped `/` and newlines and buys
 * nothing at M4).
 */
export function regExpExpr(mod: HbcModule, patternId: number, flagsId: number): Expr {
  // F23-2: `fromRegExpTable` is the provenance bit that lets `literal-forms`
  // (L-R) tell this node apart from a genuine source-level `new RegExp(...)`.
  return { k: "new", callee: { k: "ident", name: "RegExp" }, args: [stringLiteral(mod, patternId), stringLiteral(mod, flagsId)], fromRegExpTable: true };
}

/**
 * The raw serialized values of a `NewObjectWithBuffer*` literal — the same
 * two buffers `objectFromBuffers` reads (v≤96 `objValueBuffer`, v≥97
 * `literalValueBuffer`), but returned undecorated for the ANALYSIS surfaces
 * that want the values themselves rather than an AST
 * (`src/artifact/object-tables.ts`, spec 10 §3.1 `query object-tables`).
 * A member the buffer cannot supply is `null`, exactly as `readValuesTolerant`
 * reports it — never an exception.
 */
export function objectBufferValues(mod: HbcModule, valueOffset: number, count: number): readonly (SerializedLiteral | null)[] {
  const buffer = mod.header.version >= 97 ? mod.literalValueBuffer : mod.objValueBuffer;
  return readValuesTolerant(buffer, valueOffset, count, mod.header.version);
}

/**
 * `objectKeys` without the throw: `null` when the key buffer does not hold
 * `numProps` decodable property names. A bundle-wide inventory scans literals
 * it was never asked about (`query object-tables`), so one malformed key
 * buffer must skip that literal rather than fail the whole scan; the emitter
 * still uses `objectKeys`, whose refusal is load-bearing there.
 */
export function objectKeysTolerant(mod: HbcModule, keyBufferOffset: number, numProps: number): string[] | null {
  const values = readValuesTolerant(mod.objKeyBuffer, keyBufferOffset, numProps, mod.header.version);
  const keys: string[] = [];
  for (const v of values) {
    if (v === null) return null;
    if (v.kind === "string") {
      try {
        keys.push(mod.strings.get(v.stringId));
      } catch {
        return null;
      }
      continue;
    }
    if (v.kind === "integer" || v.kind === "number") {
      keys.push(renderNumber(v.value));
      continue;
    }
    return null;
  }
  return keys;
}
