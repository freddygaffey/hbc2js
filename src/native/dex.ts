// src/native/dex.ts — a read-only, minimal DEX reader.
// docs/specs/27-native-side.md §L1.1: header + string/type/proto/field/method
// id tables + `class_def_item`s + the annotations directory. Method *bodies*
// are deliberately NOT decoded (§1.2's honest, bounded gap): a fact that lives
// in an instruction stream is unresolved here, never guessed.
//
// Layout derived from the public AOSP `dex-format` documentation (Apache-2.0
// project docs), the same posture as deriving Hermes opcodes from MIT
// `BytecodeList.def`. No code is copied from any DEX tool.
import { ErrorCode, Hbc2jsError } from "../errors.ts";

/** §L1.1: header fields we read and *report*; the checksum/signature are
 *  reported, never used as a gate (a repacked APK is still readable). */
export interface DexHeader {
  readonly version: string; // "035".."041"
  readonly checksum: number;
  readonly signature: string; // hex sha1 as stored
  readonly fileSize: number;
  readonly headerSize: number;
  readonly endianTag: number;
  readonly stringIds: { readonly size: number; readonly off: number };
  readonly typeIds: { readonly size: number; readonly off: number };
  readonly protoIds: { readonly size: number; readonly off: number };
  readonly fieldIds: { readonly size: number; readonly off: number };
  readonly methodIds: { readonly size: number; readonly off: number };
  readonly classDefs: { readonly size: number; readonly off: number };
}

export interface DexProto {
  readonly shorty: string;
  readonly returnType: string;
  readonly parameters: readonly string[];
  /** `(Ljava/lang/String;)V` — the form used in method keys. */
  readonly descriptor: string;
}

export interface DexField {
  readonly class: string;
  readonly type: string;
  readonly name: string;
}

export interface DexMethodId {
  readonly class: string;
  readonly proto: DexProto;
  readonly name: string;
}

export interface DexAnnotation {
  readonly visibility: "build" | "runtime" | "system";
  readonly type: string;
  readonly elements: Record<string, unknown>;
}

export interface DexMethod {
  readonly class: string;
  readonly name: string;
  readonly proto: string;
  readonly access: readonly string[];
  readonly accessFlags: number;
  readonly annotations: readonly DexAnnotation[];
  /** `true` for direct methods (static/private/constructor). */
  readonly direct: boolean;
  /** §1.2's one narrow, bounded exception to "no method bodies": when the
   *  method has a code item that is EXACTLY the two-instruction sequence
   *  `const-string vAA, "..."` followed by `return-object vAA`, the returned
   *  string is read straight from the string pool (spec 27 §L2 "recovered as
   *  the sole const-string such a one-line method returns"). This is a fixed
   *  6-byte pattern match, never a general instruction interpreter: any other
   *  shape of body (or none) leaves this `undefined`/`null` — unresolved, not
   *  guessed. `undefined` = no code item at all; `null` = a code item present
   *  but not this exact shape. */
  readonly constStringReturn?: string | null;
}

export interface DexClass {
  readonly name: string;
  readonly super: string | null;
  readonly interfaces: readonly string[];
  readonly access: readonly string[];
  readonly accessFlags: number;
  readonly sourceFile: string | null;
  readonly annotations: readonly DexAnnotation[];
  readonly methods: readonly DexMethod[];
  /** `static` fields, with the `static_values` constant when the class carries
   *  one (a `static final` initialiser DEX stores as data, not as code — so it
   *  is readable without decoding a method body). `value` is `undefined` when
   *  the class has no static-values array covering that field. */
  readonly staticFields: readonly { readonly name: string; readonly type: string; readonly access: readonly string[]; readonly value?: unknown }[];
}

export interface DexImage {
  readonly header: DexHeader;
  readonly strings: readonly string[];
  readonly types: readonly string[];
  readonly protos: readonly DexProto[];
  readonly fields: readonly DexField[];
  readonly methods: readonly DexMethodId[];
  readonly classes: readonly DexClass[];
}

const ACCESS_FLAGS: readonly (readonly [number, string])[] = [
  [0x1, "public"],
  [0x2, "private"],
  [0x4, "protected"],
  [0x8, "static"],
  [0x10, "final"],
  [0x20, "synchronized"],
  [0x40, "volatile"],
  [0x80, "transient"],
  [0x100, "native"],
  [0x200, "interface"],
  [0x400, "abstract"],
  [0x800, "strictfp"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
];

const NO_INDEX = 0xffffffff;

export function accessFlagNames(flags: number): string[] {
  const out: string[] = [];
  for (const [bit, name] of ACCESS_FLAGS) if ((flags & bit) !== 0) out.push(name);
  return out;
}

class Cursor {
  readonly b: Uint8Array;
  p: number;
  constructor(b: Uint8Array, p: number) {
    this.b = b;
    this.p = p;
  }
  u1(): number {
    this.need(1);
    return this.b[this.p++]!;
  }
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u1();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) throw bad(ErrorCode.E_TRUNCATED, "uleb128 longer than 5 bytes", this.p);
    }
    return result >>> 0;
  }
  need(n: number): void {
    if (this.p + n > this.b.length) throw bad(ErrorCode.E_TRUNCATED, `read ran past end of dex (needed ${n} bytes)`, this.p);
  }
}

function bad(code: (typeof ErrorCode)[keyof typeof ErrorCode], message: string, offset: number): Hbc2jsError {
  return new Hbc2jsError(code, `dex: ${message}`, {
    offset,
    hint: "an unreadable DEX is refused; the native ingester never emits a partially fabricated table (spec 27 §1.4)",
  });
}

function u16(b: Uint8Array, o: number): number {
  if (o + 2 > b.length) throw bad(ErrorCode.E_TRUNCATED, "u16 past end", o);
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) throw bad(ErrorCode.E_TRUNCATED, "u32 past end", o);
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

const DEX_MAGIC = [0x64, 0x65, 0x78, 0x0a]; // "dex\n"

/** MUTF-8, as DEX stores string data (NUL-terminated, 0xC0 0x80 for U+0000,
 *  surrogate pairs encoded separately). */
function readMutf8(b: Uint8Array, start: number, utf16Length: number): string {
  let p = start;
  let out = "";
  for (let i = 0; i < utf16Length; i++) {
    if (p >= b.length) throw bad(ErrorCode.E_TRUNCATED, "string data past end", p);
    const a = b[p++]!;
    if (a < 0x80) {
      out += String.fromCharCode(a);
    } else if ((a & 0xe0) === 0xc0) {
      const b1 = b[p++] ?? 0;
      out += String.fromCharCode(((a & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((a & 0xf0) === 0xe0) {
      const b1 = b[p++] ?? 0;
      const b2 = b[p++] ?? 0;
      out += String.fromCharCode(((a & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else {
      throw bad(ErrorCode.E_BAD_STRING_ID, `illegal MUTF-8 lead byte 0x${a.toString(16)}`, p - 1);
    }
  }
  return out;
}

function parseHeader(b: Uint8Array): DexHeader {
  if (b.length < 112) throw bad(ErrorCode.E_TRUNCATED, `blob is ${b.length} bytes, shorter than a 112-byte dex header`, 0);
  for (let i = 0; i < 4; i++) {
    if (b[i] !== DEX_MAGIC[i]) throw bad(ErrorCode.E_BAD_MAGIC, "magic is not 'dex\\n'", 0);
  }
  const version = String.fromCharCode(b[4]!, b[5]!, b[6]!);
  if (!/^0[0-9][0-9]$/.test(version) || b[7] !== 0) throw bad(ErrorCode.E_BAD_MAGIC, `unrecognised dex version tag ${JSON.stringify(version)}`, 4);
  const endianTag = u32(b, 40);
  if (endianTag !== 0x12345678) {
    throw bad(ErrorCode.E_UNSUPPORTED_VERSION, `endian tag 0x${endianTag.toString(16)} is not little-endian (0x12345678)`, 40);
  }
  const fileSize = u32(b, 32);
  if (fileSize > b.length) throw bad(ErrorCode.E_TRUNCATED, `header says file_size=${fileSize} but the blob is ${b.length} bytes`, 32);
  let signature = "";
  for (let i = 12; i < 32; i++) signature += b[i]!.toString(16).padStart(2, "0");
  const sec = (o: number): { size: number; off: number } => ({ size: u32(b, o), off: u32(b, o + 4) });
  const header: DexHeader = {
    version,
    checksum: u32(b, 8),
    signature,
    fileSize,
    headerSize: u32(b, 36),
    endianTag,
    stringIds: sec(56),
    typeIds: sec(64),
    protoIds: sec(72),
    fieldIds: sec(80),
    methodIds: sec(88),
    classDefs: sec(96),
  };
  for (const [name, s] of [
    ["string_ids", header.stringIds],
    ["type_ids", header.typeIds],
    ["proto_ids", header.protoIds],
    ["field_ids", header.fieldIds],
    ["method_ids", header.methodIds],
    ["class_defs", header.classDefs],
  ] as const) {
    if (s.size > 0 && s.off + s.size > b.length) throw bad(ErrorCode.E_SECTION_OVERRUN, `${name} table starts past end of file`, s.off);
  }
  return header;
}

function decodeValue(c: Cursor, strings: readonly string[], types: readonly string[]): unknown {
  const arg = c.u1();
  const type = arg & 0x1f;
  const size = (arg >> 5) + 1;
  const readUInt = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v |= c.u1() << (8 * i);
    return v >>> 0;
  };
  const readSInt = (n: number): number => {
    let v = 0;
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = c.u1();
      v |= last << (8 * i);
    }
    // sign-extend from the top byte actually read
    const shift = 32 - 8 * n;
    return shift > 0 ? (v << shift) >> shift : v | 0;
  };
  switch (type) {
    case 0x00: // BYTE
    case 0x02: // SHORT
    case 0x04: // INT
      return readSInt(size);
    case 0x03: // CHAR
      return readUInt(size);
    case 0x06: {
      // LONG — read as bigint-safe number where possible, else a string.
      let v = 0n;
      for (let i = 0; i < size; i++) v |= BigInt(c.u1()) << BigInt(8 * i);
      const bits = BigInt(8 * size);
      if (v >= 1n << (bits - 1n)) v -= 1n << bits;
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
    }
    case 0x10: {
      // FLOAT — value_arg bytes are the HIGH-order bytes, zero-extended low.
      const buf = new Uint8Array(4);
      for (let i = 0; i < size; i++) buf[4 - size + i] = c.u1();
      return new DataView(buf.buffer).getFloat32(0, true);
    }
    case 0x11: {
      const buf = new Uint8Array(8);
      for (let i = 0; i < size; i++) buf[8 - size + i] = c.u1();
      return new DataView(buf.buffer).getFloat64(0, true);
    }
    case 0x17: {
      const idx = readUInt(size);
      return strings[idx] ?? { unresolved: true };
    }
    case 0x18: {
      const idx = readUInt(size);
      return types[idx] ?? { unresolved: true };
    }
    case 0x19: // FIELD
    case 0x1a: // METHOD
    case 0x1b: // ENUM
    case 0x15: // METHOD_TYPE
    case 0x16: {
      // METHOD_HANDLE — an index into a table we do not model; keep the index.
      const idx = readUInt(size);
      return { index: idx };
    }
    case 0x1c: {
      const count = c.uleb();
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) out.push(decodeValue(c, strings, types));
      return out;
    }
    case 0x1d:
      return decodeAnnotationBody(c, strings, types);
    case 0x1e:
      return null;
    case 0x1f:
      return (arg >> 5) !== 0;
    default:
      return { unresolved: true };
  }
}

function decodeAnnotationBody(c: Cursor, strings: readonly string[], types: readonly string[]): { type: string; elements: Record<string, unknown> } {
  const typeIdx = c.uleb();
  const count = c.uleb();
  const elements: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const nameIdx = c.uleb();
    const name = strings[nameIdx] ?? `?${nameIdx}`;
    elements[name] = decodeValue(c, strings, types);
  }
  return { type: types[typeIdx] ?? `?${typeIdx}`, elements };
}

const VISIBILITY: readonly DexAnnotation["visibility"][] = ["build", "runtime", "system"];

function readAnnotationSet(b: Uint8Array, off: number, strings: readonly string[], types: readonly string[]): DexAnnotation[] {
  if (off === 0) return [];
  const size = u32(b, off);
  const out: DexAnnotation[] = [];
  for (let i = 0; i < size; i++) {
    const itemOff = u32(b, off + 4 + 4 * i);
    if (itemOff === 0) continue;
    const c = new Cursor(b, itemOff);
    const vis = c.u1();
    const body = decodeAnnotationBody(c, strings, types);
    out.push({ visibility: VISIBILITY[vis] ?? "system", type: body.type, elements: body.elements });
  }
  return out;
}

/** §1.2 / §L2's one bounded body read: a `code_item` at `off` that is exactly
 *  `const-string vAA, string@BBBB` (opcode 0x1a, format 21c) immediately
 *  followed by `return-object vAA` (opcode 0x11, format 11x) on the SAME
 *  register, and nothing else. Returns the string when it matches, `null`
 *  when a code item exists but is any other shape. Never decodes further. */
function decodeTrivialStringReturn(b: Uint8Array, off: number, strings: readonly string[]): string | null {
  // code_item header: registers_size, ins_size, outs_size, tries_size (u2
  // each), debug_info_off (u4), insns_size (u4), then insns_size * u2 insns.
  const insnsSize = u32(b, off + 12);
  const insnsOff = off + 16;
  if (insnsSize !== 3) return null;
  const cu0 = u16(b, insnsOff);
  const cu1 = u16(b, insnsOff + 2);
  const cu2 = u16(b, insnsOff + 4);
  const op0 = cu0 & 0xff;
  const reg0 = (cu0 >> 8) & 0xff;
  const op2 = cu2 & 0xff;
  const reg2 = (cu2 >> 8) & 0xff;
  if (op0 !== 0x1a || op2 !== 0x11 || reg0 !== reg2) return null;
  return strings[cu1] ?? null;
}

/** Parse one `classes*.dex` blob. Throws `Hbc2jsError` on anything it cannot
 *  read; never returns a partial image (spec 27 §1.4). */
export function parseDex(bytes: Uint8Array): DexImage {
  const header = parseHeader(bytes);

  const strings: string[] = [];
  for (let i = 0; i < header.stringIds.size; i++) {
    const dataOff = u32(bytes, header.stringIds.off + 4 * i);
    const c = new Cursor(bytes, dataOff);
    const utf16Length = c.uleb();
    strings.push(readMutf8(bytes, c.p, utf16Length));
  }

  const types: string[] = [];
  for (let i = 0; i < header.typeIds.size; i++) {
    const idx = u32(bytes, header.typeIds.off + 4 * i);
    const s = strings[idx];
    if (s === undefined) throw bad(ErrorCode.E_BAD_STRING_ID, `type_id ${i} points at string ${idx}, out of range`, header.typeIds.off + 4 * i);
    types.push(s);
  }

  const typeList = (off: number): string[] => {
    if (off === 0) return [];
    const size = u32(bytes, off);
    const out: string[] = [];
    for (let i = 0; i < size; i++) out.push(types[u16(bytes, off + 4 + 2 * i)] ?? "?");
    return out;
  };

  const protos: DexProto[] = [];
  for (let i = 0; i < header.protoIds.size; i++) {
    const o = header.protoIds.off + 12 * i;
    const shorty = strings[u32(bytes, o)] ?? "?";
    const returnType = types[u32(bytes, o + 4)] ?? "?";
    const parameters = typeList(u32(bytes, o + 8));
    protos.push({ shorty, returnType, parameters, descriptor: `(${parameters.join("")})${returnType}` });
  }

  const fields: DexField[] = [];
  for (let i = 0; i < header.fieldIds.size; i++) {
    const o = header.fieldIds.off + 8 * i;
    fields.push({
      class: types[u16(bytes, o)] ?? "?",
      type: types[u16(bytes, o + 2)] ?? "?",
      name: strings[u32(bytes, o + 4)] ?? "?",
    });
  }

  const methods: DexMethodId[] = [];
  for (let i = 0; i < header.methodIds.size; i++) {
    const o = header.methodIds.off + 8 * i;
    const proto = protos[u16(bytes, o + 2)];
    methods.push({
      class: types[u16(bytes, o)] ?? "?",
      proto: proto ?? { shorty: "?", returnType: "?", parameters: [], descriptor: "()?" },
      name: strings[u32(bytes, o + 4)] ?? "?",
    });
  }

  const classes: DexClass[] = [];
  for (let i = 0; i < header.classDefs.size; i++) {
    const o = header.classDefs.off + 32 * i;
    const classIdx = u32(bytes, o);
    const name = types[classIdx];
    if (name === undefined) throw bad(ErrorCode.E_TABLE_ASSERT, `class_def ${i} names type ${classIdx}, out of range`, o);
    const accessFlags = u32(bytes, o + 4);
    const superIdx = u32(bytes, o + 8);
    const interfacesOff = u32(bytes, o + 12);
    const sourceFileIdx = u32(bytes, o + 16);
    const annotationsOff = u32(bytes, o + 20);
    const classDataOff = u32(bytes, o + 24);
    const staticValuesOff = u32(bytes, o + 28);

    let classAnnotations: DexAnnotation[] = [];
    const methodAnnotations = new Map<number, DexAnnotation[]>();
    if (annotationsOff !== 0) {
      classAnnotations = readAnnotationSet(bytes, u32(bytes, annotationsOff), strings, types);
      const fieldsSize = u32(bytes, annotationsOff + 4);
      const methodsSize = u32(bytes, annotationsOff + 8);
      const paramsSize = u32(bytes, annotationsOff + 12);
      const methodsStart = annotationsOff + 16 + 8 * fieldsSize;
      for (let m = 0; m < methodsSize; m++) {
        const midx = u32(bytes, methodsStart + 8 * m);
        methodAnnotations.set(midx, readAnnotationSet(bytes, u32(bytes, methodsStart + 8 * m + 4), strings, types));
      }
      void paramsSize; // parameter annotations are not part of the L1 contract
    }

    const classMethods: DexMethod[] = [];
    const staticFields: { name: string; type: string; access: string[]; value?: unknown }[] = [];
    // static_values is an encoded_array positionally matching the first N
    // static fields (AOSP dex-format); shorter than the field list is legal.
    const staticValues: unknown[] = [];
    if (staticValuesOff !== 0) {
      const sv = new Cursor(bytes, staticValuesOff);
      const n = sv.uleb();
      for (let i = 0; i < n; i++) staticValues.push(decodeValue(sv, strings, types));
    }
    if (classDataOff !== 0) {
      const c = new Cursor(bytes, classDataOff);
      const staticFieldsSize = c.uleb();
      const instanceFieldsSize = c.uleb();
      const directMethodsSize = c.uleb();
      const virtualMethodsSize = c.uleb();
      let fieldIdx = 0;
      for (let f = 0; f < staticFieldsSize; f++) {
        fieldIdx += c.uleb();
        const flags = c.uleb();
        const fld = fields[fieldIdx];
        if (fld !== undefined) {
          const row: { name: string; type: string; access: string[]; value?: unknown } = { name: fld.name, type: fld.type, access: accessFlagNames(flags) };
          if (f < staticValues.length) row.value = staticValues[f];
          staticFields.push(row);
        }
      }
      fieldIdx = 0;
      for (let f = 0; f < instanceFieldsSize; f++) {
        fieldIdx += c.uleb();
        c.uleb();
      }
      for (const [count, direct] of [
        [directMethodsSize, true],
        [virtualMethodsSize, false],
      ] as const) {
        let methodIdx = 0;
        for (let m = 0; m < count; m++) {
          methodIdx += c.uleb();
          const flags = c.uleb();
          // code_off is read but deliberately not followed as a general
          // instruction stream (§1.2: no bodies) — the ONE bounded exception
          // is `decodeTrivialStringReturn` (spec 27 §L2), a fixed 6-byte
          // pattern match, not an interpreter.
          const codeOff = c.uleb();
          const mid = methods[methodIdx];
          if (mid === undefined) throw bad(ErrorCode.E_BAD_FUNCTION_ID, `class_data names method ${methodIdx}, out of range`, classDataOff);
          classMethods.push({
            class: mid.class,
            name: mid.name,
            proto: mid.proto.descriptor,
            access: accessFlagNames(flags),
            accessFlags: flags,
            annotations: methodAnnotations.get(methodIdx) ?? [],
            direct,
            ...(codeOff === 0 ? {} : { constStringReturn: decodeTrivialStringReturn(bytes, codeOff, strings) }),
          });
        }
      }
    }

    classes.push({
      name,
      super: superIdx === NO_INDEX ? null : (types[superIdx] ?? null),
      interfaces: typeList(interfacesOff),
      access: accessFlagNames(accessFlags),
      accessFlags,
      sourceFile: sourceFileIdx === NO_INDEX ? null : (strings[sourceFileIdx] ?? null),
      annotations: classAnnotations,
      methods: classMethods,
      staticFields,
    });
  }

  return { header, strings, types, protos, fields, methods, classes };
}
