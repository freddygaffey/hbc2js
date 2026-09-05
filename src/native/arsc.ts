// src/native/arsc.ts — a minimal `resources.arsc` decoder.
// docs/specs/27-native-side.md §L1.3: the global string pool + package/type/
// entry tables, enough to resolve `@string/...` and dump `res/values*` key ->
// value pairs (the `.env` channel of L6).
//
// Truth rule (§L1/§4.2): a value that is itself a resource reference stays a
// reference (`{ref:"@string/x"}`) — it is never flattened by guessing; a
// complex (bag/style) entry is `{unresolved:true}`, not invented.
import { nativeResourceKey } from "../name-overlay/id.ts";
import type { NativeResourceRow, NativeResourceValue } from "./schema.ts";
import {
  eachChunk,
  readChunk,
  readStringPool,
  RES_STRING_POOL_TYPE,
  RES_TABLE_PACKAGE_TYPE,
  RES_TABLE_TYPE,
  RES_TABLE_TYPE_TYPE,
  resErr,
  ru16,
  ru32,
  TYPE_ATTRIBUTE,
  TYPE_INT_BOOLEAN,
  TYPE_INT_DEC,
  TYPE_INT_HEX,
  TYPE_NULL,
  TYPE_REFERENCE,
  TYPE_STRING,
  type ResStringPool,
} from "./restable.ts";

export interface ArscEntry {
  readonly id: number; // 0xPPTTEEEE
  readonly pkg: string;
  readonly type: string;
  readonly name: string;
  readonly config: string;
  readonly value: NativeResourceValue;
}

export interface ArscTable {
  readonly packages: readonly { readonly id: number; readonly name: string }[];
  readonly entries: readonly ArscEntry[];
  readonly notes: readonly string[];
}

export function looksLikeArsc(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ru16(bytes, 0) === RES_TABLE_TYPE;
}

/** Decode a `resources.arsc` blob. Throws on a malformed chunk (§1.4). */
export function parseArsc(bytes: Uint8Array): ArscTable {
  const root = readChunk(bytes, 0);
  if (root.type !== RES_TABLE_TYPE) throw resErr(`not a resource table (chunk type 0x${root.type.toString(16)})`, 0);
  let globalStrings: ResStringPool | null = null;
  const packages: { id: number; name: string }[] = [];
  const entries: ArscEntry[] = [];
  const notes: string[] = [];
  // Two passes: the reference-resolving pass below needs every entry's name,
  // so decoding is done once and references are named afterwards.
  const raw: { id: number; pkg: string; type: string; name: string; config: string; dataType: number; data: number }[] = [];

  eachChunk(bytes, root.headerSize, Math.min(root.size, bytes.length), (c) => {
    if (c.type === RES_STRING_POOL_TYPE && globalStrings === null) {
      globalStrings = readStringPool(bytes, c);
      return;
    }
    if (c.type !== RES_TABLE_PACKAGE_TYPE) return;
    const pkgId = ru32(bytes, c.offset + 8);
    let pkgName = "";
    for (let i = 0; i < 128; i++) {
      const ch = ru16(bytes, c.offset + 12 + 2 * i);
      if (ch === 0) break;
      pkgName += String.fromCharCode(ch);
    }
    const typeStringsOff = ru32(bytes, c.offset + 268);
    const keyStringsOff = ru32(bytes, c.offset + 276);
    const typeStrings = readStringPool(bytes, readChunk(bytes, c.offset + typeStringsOff));
    const keyStrings = readStringPool(bytes, readChunk(bytes, c.offset + keyStringsOff));
    packages.push({ id: pkgId, name: pkgName });

    eachChunk(bytes, c.offset + c.headerSize, c.offset + c.size, (inner) => {
      if (inner.type !== RES_TABLE_TYPE_TYPE) return;
      const typeId = bytes[inner.offset + 8]!;
      const flags = bytes[inner.offset + 9]!;
      const entryCount = ru32(bytes, inner.offset + 12);
      const entriesStart = ru32(bytes, inner.offset + 16);
      const typeName = typeStrings.at(typeId - 1) ?? `type${typeId}`;
      const config = configName(bytes, inner.offset + 20);
      if ((flags & 0x01) !== 0) {
        notes.push(`resources.arsc: type ${typeName} config ${config} uses a sparse entry table, which this reader does not decode; its entries are omitted, never guessed`);
        return;
      }
      const offsets16 = (flags & 0x02) !== 0;
      for (let i = 0; i < entryCount; i++) {
        const rawOff = offsets16 ? ru16(bytes, inner.offset + inner.headerSize + 2 * i) : ru32(bytes, inner.offset + inner.headerSize + 4 * i);
        if (offsets16 ? rawOff === 0xffff : rawOff === 0xffffffff) continue;
        const entryOff = inner.offset + entriesStart + (offsets16 ? rawOff * 4 : rawOff);
        const entryFlags = ru16(bytes, entryOff + 2);
        const keyIdx = ru32(bytes, entryOff + 4);
        const name = keyStrings.at(keyIdx) ?? `key${keyIdx}`;
        const id = ((pkgId << 24) | (typeId << 16) | i) >>> 0;
        if ((entryFlags & 0x0001) !== 0) {
          // A complex (bag/style/array) entry: out of L1's contract.
          entries.push({ id, pkg: pkgName, type: typeName, name, config, value: { unresolved: true } });
          continue;
        }
        raw.push({ id, pkg: pkgName, type: typeName, name, config, dataType: bytes[entryOff + 8 + 3]!, data: ru32(bytes, entryOff + 8 + 4) });
      }
    });
  });

  const byId = new Map<number, { type: string; name: string }>();
  for (const r of raw) if (!byId.has(r.id)) byId.set(r.id, { type: r.type, name: r.name });

  const gs: ResStringPool | null = globalStrings;
  for (const r of raw) {
    entries.push({ id: r.id, pkg: r.pkg, type: r.type, name: r.name, config: r.config, value: decodeEntryValue(r.dataType, r.data, gs, byId) });
  }
  entries.sort((a, b) => (a.id === b.id ? (a.config < b.config ? -1 : a.config > b.config ? 1 : 0) : a.id - b.id));
  return { packages, entries, notes };
}

function decodeEntryValue(dataType: number, data: number, strings: ResStringPool | null, byId: ReadonlyMap<number, { type: string; name: string }>): NativeResourceValue {
  switch (dataType) {
    case TYPE_STRING: {
      const s = strings === null ? null : strings.at(data);
      return s ?? { unresolved: true };
    }
    case TYPE_INT_BOOLEAN:
      return data !== 0;
    case TYPE_INT_DEC:
      return data | 0;
    case TYPE_INT_HEX:
      return data >>> 0;
    case TYPE_NULL:
      return { unresolved: true };
    case TYPE_REFERENCE:
    case TYPE_ATTRIBUTE: {
      // Stays a reference — never flattened to the target's value (§L1).
      const target = byId.get(data >>> 0);
      const prefix = dataType === TYPE_ATTRIBUTE ? "?" : "@";
      return { ref: target === undefined ? `${prefix}0x${(data >>> 0).toString(16).padStart(8, "0")}` : `${prefix}${target.type}/${target.name}` };
    }
    default:
      return { unresolved: true };
  }
}

const DENSITIES: Record<number, string> = { 120: "ldpi", 160: "mdpi", 213: "tvdpi", 240: "hdpi", 320: "xhdpi", 480: "xxhdpi", 640: "xxxhdpi", 0xfffe: "anydpi", 0xffff: "nodpi" };

/** A deterministic label for a `ResTable_config`: `default` when every byte
 *  past the size field is zero, else the parts we can name (language, density)
 *  and a hex fingerprint otherwise — a label, never an invented fact. */
function configName(b: Uint8Array, off: number): string {
  const size = ru32(b, off);
  if (size < 4 || off + size > b.length) return "default";
  let allZero = true;
  for (let i = 4; i < size; i++) {
    if (b[off + i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return "default";
  const parts: string[] = [];
  if (size >= 12) {
    const l0 = b[off + 8]!;
    const l1 = b[off + 9]!;
    if (l0 !== 0) parts.push(String.fromCharCode(l0, l1));
    const c0 = b[off + 10]!;
    const c1 = b[off + 11]!;
    if (c0 !== 0) parts.push(`r${String.fromCharCode(c0, c1)}`);
  }
  if (size >= 20) {
    const density = ru16(b, off + 18);
    if (density !== 0) parts.push(DENSITIES[density] ?? `${density}dpi`);
  }
  if (parts.length > 0) return parts.join("-");
  let hex = "";
  for (let i = 4; i < size; i++) hex += b[off + i]!.toString(16).padStart(2, "0");
  return `cfg-${hex}`;
}

/** The `native/resources.jsonl` rows for a decoded table, sorted by key. */
export function resourceRows(table: ArscTable): NativeResourceRow[] {
  const rows = table.entries.map((e) => ({
    key: nativeResourceKey(e.pkg, e.type, e.name),
    value: e.value,
    config: e.config,
    type: e.type,
  }));
  rows.sort((a, b) => (a.key === b.key ? (a.config < b.config ? -1 : a.config > b.config ? 1 : 0) : a.key < b.key ? -1 : 1));
  return rows;
}

/** Resolve `@string/name` (or `@pkg:string/name`) to its value in `config`.
 *  Returns `null` when the table has no such entry — never a guess. */
export function resolveReference(table: ArscTable, ref: string, config = "default"): NativeResourceValue | null {
  const m = /^[@?]?(?:([^:]+):)?([A-Za-z0-9_]+)\/([A-Za-z0-9_.]+)$/.exec(ref);
  if (m === null) return null;
  const [, pkg, type, name] = m;
  for (const e of table.entries) {
    if (e.type !== type || e.name !== name || e.config !== config) continue;
    if (pkg !== undefined && e.pkg !== pkg) continue;
    return e.value;
  }
  return null;
}
