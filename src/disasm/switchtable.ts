// docs/specs/02-disassembler.md §4 — switch jump tables (SwitchImm/UIntSwitchImm,
// StringSwitchImm). Two traps documented in the spec and both load-bearing here:
//
// 1. The alignment trap: Hermes aligns the *runtime* (absolute file) address of
//    the table, not the function-relative offset, so `alignUp` must run on
//    `functionOffset + insnOffset + tableOffset`, never on `insnOffset +
//    tableOffset` alone (docs/HBC-FORMAT.md §11.1, §12.7).
// 2. The extent trap: the table lives *beyond* `bytecodeSizeInBytes`, so its
//    bytes are read from the whole-file `bytes`, never from a function body
//    subarray (docs/HBC-FORMAT.md §12.8).
import { ErrorCode, Hbc2jsError } from "../errors.ts";

export interface SwitchCase {
  /** The integer case value, or the string id. */
  readonly value: number;
  /** Function-relative. */
  readonly target: number;
}

export interface SwitchTable {
  readonly kind: "uint" | "string";
  /** Function-relative, post-alignment. */
  readonly tableOffset: number;
  readonly byteLength: number;
  /** Function-relative. */
  readonly defaultTarget: number;
  /** "uint" only; 0 for "string" (docs/specs/02-disassembler.md §3.1 keeps this
   *  field non-optional across both kinds; there is no meaningful min/max for a
   *  string switch, so it is set to 0 rather than added as an optional field —
   *  see this milestone's report for the rationale). */
  readonly min: number;
  readonly max: number;
  readonly cases: readonly SwitchCase[];
}

// A ceiling on case count, not a real Hermes limit: a bigger table is corruption
// (docs/specs/02-disassembler.md §4.1).
const MAX_CASES = 1 << 20;
const FOOTER_SIZE = 20; // trailing SHA-1 (docs/HBC-FORMAT.md §12 item 10).

const viewCache = new WeakMap<Uint8Array, DataView>();
function fileView(bytes: Uint8Array): DataView {
  const cached = viewCache.get(bytes);
  if (cached !== undefined) return cached;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  viewCache.set(bytes, view);
  return view;
}

function alignUp4(n: number): number {
  return (n + 3) & ~3;
}

function fail(message: string, functionIndex: number, offset: number): never {
  throw new Hbc2jsError(ErrorCode.E_SWITCH_TABLE, message, { functionIndex, offset, section: "disasm/switchtable" });
}

interface CommonParams {
  readonly bytes: Uint8Array;
  readonly fileLength: number;
  readonly functionOffset: number;
  readonly bytecodeSize: number;
  readonly insnOffset: number;
  readonly functionIndex: number;
  readonly tableOffset: number;
  readonly defaultTarget: number;
}

function resolveTable(p: CommonParams, count: number, entryWidth: number): { view: DataView; tableAbs: number; tableRel: number; byteLength: number; resolvedDefault: number } {
  if (count < 0 || count > MAX_CASES) {
    fail(`switch table has ${count} entries, outside the sanity ceiling [0, ${MAX_CASES}]`, p.functionIndex, p.functionOffset + p.insnOffset);
  }
  // docs/HBC-FORMAT.md §11.1: "Arg2 is unaligned; it is dynamically aligned" —
  // alignment happens on the absolute runtime address, not the function-relative
  // offset (docs/specs/02-disassembler.md §4.1's "alignment trap").
  const ipAbs = p.functionOffset + p.insnOffset;
  const tableAbs = alignUp4(ipAbs + p.tableOffset);
  const tableRel = tableAbs - p.functionOffset;
  const byteLength = entryWidth * count;
  if (tableAbs + byteLength > p.fileLength - FOOTER_SIZE) {
    fail(`switch table at absolute offset 0x${tableAbs.toString(16)} (${byteLength} bytes) runs past the file (fileLength=${p.fileLength})`, p.functionIndex, ipAbs);
  }
  const resolvedDefault = p.insnOffset + p.defaultTarget;
  if (resolvedDefault < 0 || resolvedDefault >= p.bytecodeSize) {
    fail(`switch default target ${resolvedDefault} outside [0, ${p.bytecodeSize})`, p.functionIndex, ipAbs);
  }
  return { view: fileView(p.bytes), tableAbs, tableRel, byteLength, resolvedDefault };
}

export interface DecodeUintSwitchParams extends CommonParams {
  readonly min: number;
  readonly max: number;
}

/** `SwitchImm` (v<=96) / `UIntSwitchImm` (v>=99). docs/specs/02-disassembler.md
 *  §4.1 — the worked example there (`constructs/52-switch-jumptable`) is this
 *  function's unit test. */
export function decodeUintSwitch(p: DecodeUintSwitchParams): SwitchTable {
  if (p.max < p.min) {
    fail(`switch max (${p.max}) < min (${p.min})`, p.functionIndex, p.functionOffset + p.insnOffset);
  }
  const count = p.max - p.min + 1;
  const { view, tableAbs, tableRel, byteLength, resolvedDefault } = resolveTable(p, count, 4);
  const cases: SwitchCase[] = [];
  for (let i = 0; i < count; i++) {
    const raw = view.getInt32(tableAbs + 4 * i, true);
    const target = p.insnOffset + raw;
    if (target < 0 || target >= p.bytecodeSize) {
      fail(`switch case ${i} (value ${p.min + i}) targets ${target}, outside [0, ${p.bytecodeSize})`, p.functionIndex, p.functionOffset + p.insnOffset);
    }
    cases.push({ value: p.min + i, target });
  }
  return { kind: "uint", tableOffset: tableRel, byteLength, defaultTarget: resolvedDefault, min: p.min, max: p.max, cases };
}

export interface DecodeStringSwitchParams extends CommonParams {
  readonly tableSize: number;
  readonly stringCount: number;
}

/** `StringSwitchImm` (v>=99). docs/specs/02-disassembler.md §4.2. */
export function decodeStringSwitch(p: DecodeStringSwitchParams): SwitchTable {
  const { view, tableAbs, tableRel, byteLength, resolvedDefault } = resolveTable(p, p.tableSize, 8);
  const cases: SwitchCase[] = [];
  for (let i = 0; i < p.tableSize; i++) {
    const entryAbs = tableAbs + 8 * i;
    const stringId = view.getUint32(entryAbs, true);
    if (stringId >= p.stringCount) {
      throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `string switch case ${i}: string id ${stringId} out of range [0, ${p.stringCount})`, {
        functionIndex: p.functionIndex,
        offset: p.functionOffset + p.insnOffset,
        section: "disasm/switchtable",
      });
    }
    const raw = view.getInt32(entryAbs + 4, true);
    const target = p.insnOffset + raw;
    if (target < 0 || target >= p.bytecodeSize) {
      fail(`string switch case ${i} (string id ${stringId}) targets ${target}, outside [0, ${p.bytecodeSize})`, p.functionIndex, p.functionOffset + p.insnOffset);
    }
    cases.push({ value: stringId, target });
  }
  return { kind: "string", tableOffset: tableRel, byteLength, defaultTarget: resolvedDefault, min: 0, max: 0, cases };
}
