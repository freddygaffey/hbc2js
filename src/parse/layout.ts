// docs/specs/01-parser.md §6 — layout probing (D8). The parser probes; it never
// switches on `version` alone. On ambiguity it refuses (E_LAYOUT_AMBIGUOUS /
// E_LAYOUT_NO_CANDIDATE).
import { ErrorCode, Hbc2jsError, type Diagnostic } from "../errors.ts";
import { classLayoutConstants, HBC_MAGIC, HEADER_SIZE, paddingRange, readHeaderFields } from "./header.ts";
import { buildSectionMap } from "./sections.ts";
import { readFunctionRecord } from "./functions.ts";
import { getOpcodeTable } from "../tables/registry.ts";
import type { OpcodeTable, OpcodeTableId, OperandTypeName } from "../tables/types.ts";
import type { HbcHeader, LayoutClass, LayoutProfile, ParseOptions, ProbeCandidate } from "./types.ts";

export interface DiagnosticSink {
  push(d: Diagnostic): void;
}

export function makeDiagnosticSink(onDiagnostic?: (d: Diagnostic) => void): DiagnosticSink & { all: Diagnostic[] } {
  const all: Diagnostic[] = [];
  return {
    all,
    push(d: Diagnostic) {
      all.push(d);
      onDiagnostic?.(d);
    },
  };
}

/** §6.1 — version -> candidate layout classes and opcode-table candidates. */
function candidatesForVersion(version: number): { layouts: readonly LayoutClass[]; opcodeTables: readonly OpcodeTableId[] } {
  if (version < 51) {
    throw new Hbc2jsError(ErrorCode.E_UNSUPPORTED_VERSION, `bytecode version ${version} is below the supported floor (51)`, {});
  }
  if (version <= 83) return { layouts: ["A"], opcodeTables: [] };
  if (version === 84) return { layouts: ["B"], opcodeTables: ["hbc84"] };
  if (version <= 86) return { layouts: ["B"], opcodeTables: [] };
  if (version === 94) return { layouts: ["C"], opcodeTables: ["hbc94"] };
  if (version === 96) return { layouts: ["C"], opcodeTables: ["hbc96"] };
  if (version <= 96) return { layouts: ["C"], opcodeTables: [] };
  if (version === 97) return { layouts: ["D"], opcodeTables: [] };
  if (version === 98) return { layouts: ["D", "E"], opcodeTables: ["hbc98-late", "hbc98-2024", "hbc99-feb2026", "hbc99-mar2026"] };
  if (version === 99) return { layouts: ["E"], opcodeTables: ["hbc99-mar2026", "hbc99-feb2026"] };
  throw new Hbc2jsError(ErrorCode.E_UNSUPPORTED_VERSION, `bytecode version ${version} is above the supported ceiling (99); force --layout to try anyway`, {});
}

/** Which header layout class each opcode table's own commit actually produces —
 *  verified structurally (fetched `FUNC_HEADER_FIELDS`/`numStringSwitchImms` from
 *  each pinned commit; see docs/AGENT-LOG.md). A file already known to be layout E
 *  cannot have been produced by a compiler whose commit is layout-D shaped
 *  (`hbc98-2024`), so that candidate is pruned before P3 runs — this is applying an
 *  already-established fact, not guessing on version. */
const OPCODE_TABLE_LAYOUT: Readonly<Record<OpcodeTableId, LayoutClass>> = {
  hbc84: "B",
  hbc94: "C",
  hbc96: "C",
  "hbc98-2024": "D",
  "hbc98-late": "E",
  "hbc99-feb2026": "E",
  "hbc99-mar2026": "E",
};

interface P1Result {
  readonly ok: boolean;
  readonly detail?: string;
}

/** P1 — header shape sanity for one candidate class. */
function probeP1(bytes: Uint8Array, header: HbcHeader, layoutClass: LayoutClass): P1Result {
  const pad = paddingRange(layoutClass);
  for (let i = 0; i < pad.length; i++) {
    if (bytes[pad.start + i] !== 0) return { ok: false, detail: `padding byte at ${pad.start + i} is non-zero` };
  }
  if (header.functionCount < 1) return { ok: false, detail: "functionCount < 1" };
  if (header.globalCodeIndex >= header.functionCount) return { ok: false, detail: "globalCodeIndex >= functionCount" };
  if (header.stringCount < header.identifierCount) return { ok: false, detail: "stringCount < identifierCount" };
  if (header.overflowStringCount > header.stringCount) return { ok: false, detail: "overflowStringCount > stringCount" };
  if (!(header.debugInfoOffset === 0 || (header.debugInfoOffset >= HEADER_SIZE && header.debugInfoOffset < header.fileLength))) {
    return { ok: false, detail: "debugInfoOffset out of range" };
  }
  const c = classLayoutConstants(layoutClass);
  const counts: readonly [number, number][] = [
    [header.functionCount, c.smallFuncHeaderSize],
    [header.stringKindCount, 4],
    [header.identifierCount, 4],
    [header.stringCount, 4],
    [header.overflowStringCount, 8],
    [header.stringStorageSize, 1],
    [header.literalValueBufferSize, 1],
    [header.objKeyBufferSize, 1],
    [c.hasShapeTable ? header.objShapeTableCount : 0, 8],
    [c.hasShapeTable ? 0 : header.objValueBufferSize, 1],
    [c.hasBigIntTable ? header.bigIntCount : 0, 8],
    [c.hasBigIntTable ? header.bigIntStorageSize : 0, 1],
    [header.regExpCount, 8],
    [header.regExpStorageSize, 1],
    [header.cjsModuleCount, 8],
    [c.hasFunctionSourceTable ? header.functionSourceCount : 0, 8],
  ];
  for (const [count, stride] of counts) {
    if (count * stride > header.fileLength) return { ok: false, detail: `count*stride ${count}*${stride} > fileLength ${header.fileLength}` };
  }
  return { ok: true };
}

interface P2Result {
  readonly ok: boolean;
  readonly detail?: string;
  readonly firstFunctionBodyOffset?: number;
}

/** P2 — section-walk consistency, the decisive probe. */
function probeP2(bytes: Uint8Array, header: HbcHeader, layout: LayoutProfile): P2Result {
  let sections;
  try {
    sections = buildSectionMap(header, layout);
  } catch (e) {
    return { ok: false, detail: `section walk failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (sections.firstFunctionBodyOffset > header.fileLength - 20) {
    return { ok: false, detail: "firstFunctionBodyOffset > fileLength - 20 (P2.f)" };
  }

  const endBound = header.debugInfoOffset !== 0 ? header.debugInfoOffset : header.fileLength - 20;
  let minOffset = Infinity;
  const functionHeadersOffset = sections.span("functionHeaders").offset;

  for (let i = 0; i < header.functionCount; i++) {
    let resolved;
    try {
      resolved = readFunctionRecord(bytes, functionHeadersOffset + i * layout.smallFuncHeaderSize, i, layout.layoutClass);
    } catch (e) {
      return { ok: false, detail: `function ${i} info block unreadable: ${e instanceof Error ? e.message : String(e)}` };
    }
    const h = resolved.header;
    if (h.offset < minOffset) minOffset = h.offset;
    if (h.offset + h.bytecodeSizeInBytes > endBound) {
      return { ok: false, detail: `function ${i} offset+size ${h.offset + h.bytecodeSizeInBytes} > ${endBound} (P2.b)` };
    }
    if (h.functionNameStringId >= header.stringCount) {
      return { ok: false, detail: `function ${i} functionNameStringId ${h.functionNameStringId} >= stringCount ${header.stringCount} (P2.c)` };
    }
    if (h.infoOffset !== undefined) {
      if (h.infoOffset < sections.firstFunctionBodyOffset || h.infoOffset >= header.fileLength - 20 || h.infoOffset % 4 !== 0) {
        return { ok: false, detail: `function ${i} infoOffset ${h.infoOffset} out of range or misaligned (P2.d)` };
      }
    }
  }

  if (minOffset !== sections.firstFunctionBodyOffset) {
    return { ok: false, detail: `min(function offsets) ${minOffset} !== firstFunctionBodyOffset ${sections.firstFunctionBodyOffset} (P2.a)` };
  }
  return { ok: true, firstFunctionBodyOffset: sections.firstFunctionBodyOffset };
}

const OPERAND_BYTES: Readonly<Record<OperandTypeName, number>> = {
  Reg8: 1,
  Reg32: 4,
  UInt8: 1,
  UInt16: 2,
  UInt32: 4,
  Addr8: 1,
  Addr32: 4,
  Imm32: 4,
  Double: 8,
};

function readOperandValue(view: DataView, at: number, t: OperandTypeName): number {
  switch (t) {
    case "Reg8":
    case "UInt8":
      return view.getUint8(at);
    case "Reg32":
    case "UInt32":
      return view.getUint32(at, true);
    case "UInt16":
      return view.getUint16(at, true);
    case "Addr8":
      return view.getInt8(at);
    case "Addr32":
    case "Imm32":
      return view.getInt32(at, true);
    case "Double":
      return view.getFloat64(at, true);
  }
}

/** §6.4 — decode one function body against one candidate opcode table, purely to
 *  validate it (never produces disassembly; spec 02 owns that). Returns false at the
 *  first structural violation. */
function decodeForProbe(body: Uint8Array, table: OpcodeTable, stringCount: number, functionCount: number, bigIntCount: number): boolean {
  const byNumber = new Map(table.opcodes.map((o) => [o.n, o]));
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let addr = 0;
  while (addr < body.length) {
    const opByte = body[addr]!;
    const op = byNumber.get(opByte);
    if (op === undefined) return false;
    let cursor = addr + 1;
    const values: number[] = [];
    for (const t of op.operands) {
      const width = OPERAND_BYTES[t];
      if (cursor + width > body.length) return false;
      values.push(readOperandValue(view, cursor, t));
      cursor += width;
    }
    if (op.ids !== undefined) {
      for (const [idxStr, kind] of Object.entries(op.ids)) {
        const v = values[Number(idxStr) - 1];
        if (v === undefined) return false;
        if (kind === "string" && v >= stringCount) return false;
        if (kind === "function" && v >= functionCount) return false;
        if (kind === "bigint" && v >= bigIntCount) return false;
      }
    }
    for (let i = 0; i < op.operands.length; i++) {
      if (op.operands[i] === "Addr8" || op.operands[i] === "Addr32") {
        const target = addr + values[i]!;
        if (target < 0 || target >= body.length) return false;
      }
    }
    addr = cursor;
  }
  return addr === body.length;
}

function probeSet(functionCount: number, globalCodeIndex: number): { indices: number[]; exhaustive: boolean } {
  if (functionCount <= 32) {
    return { indices: Array.from({ length: functionCount }, (_, i) => i), exhaustive: true };
  }
  const set = new Set<number>();
  set.add(globalCodeIndex);
  for (let i = 0; i < Math.min(functionCount, 32); i++) set.add(i);
  const stride = Math.ceil(functionCount / 32);
  for (let i = 0; i < 32; i++) set.add((i * stride) % functionCount);
  return { indices: [...set].sort((a, b) => a - b), exhaustive: false };
}

/** Byte-level discriminators for the v98 D-vs-E ambiguity, docs/specs/01-parser.md
 *  §6.3. Returns a hint (`"D"` / `"E"` / `null`) plus the probe id that produced it. */
function d1d2Hint(bytes: Uint8Array, header98D: HbcHeader): { hint: LayoutClass | null; id: string } {
  const b109 = bytes[109] ?? 0;
  const b110 = bytes[110] ?? 0;
  const b111 = bytes[111] ?? 0;
  if (b109 !== 0 || b110 !== 0 || b111 !== 0) {
    return { hint: "E", id: "D1" };
  }
  const u32at104 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(104, true);
  const plausibleDebugOffset = u32at104 === 0 || (u32at104 >= HEADER_SIZE && u32at104 < header98D.fileLength && u32at104 % 4 === 0);
  if (plausibleDebugOffset) {
    return { hint: "D", id: "D2" };
  }
  return { hint: null, id: "D3/D4" };
}

export function probeLayout(bytes: Uint8Array, options: ParseOptions, diagnostics: DiagnosticSink): LayoutProfile {
  // P0 — container sanity.
  if (bytes.length < HEADER_SIZE) {
    throw new Hbc2jsError(ErrorCode.E_TRUNCATED, `file is ${bytes.length} bytes, need at least ${HEADER_SIZE}`, { offset: 0 });
  }
  const magicView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = magicView.getBigUint64(0, true);
  if (magic !== HBC_MAGIC) {
    throw new Hbc2jsError(ErrorCode.E_BAD_MAGIC, `magic is 0x${magic.toString(16)}, expected 0x${HBC_MAGIC.toString(16)}`, { offset: 0 });
  }
  const fileLength = magicView.getUint32(32, true);
  if (fileLength < HEADER_SIZE + 20 || fileLength > bytes.length) {
    throw new Hbc2jsError(ErrorCode.E_TRUNCATED, `fileLength ${fileLength} inconsistent with actual size ${bytes.length}`, { offset: 32 });
  }
  if (bytes.length > fileLength) {
    diagnostics.push({ severity: "warn", code: "W_TRAILING_BYTES", message: `${bytes.length - fileLength} trailing bytes after fileLength`, context: { offset: fileLength } });
  }

  const version = magicView.getUint32(8, true);
  const candidates = candidatesForVersion(version);

  const forcedLayout = options.layout;
  const layoutCandidates: readonly LayoutClass[] = forcedLayout !== undefined ? [forcedLayout] : candidates.layouts;
  if (forcedLayout !== undefined) {
    diagnostics.push({ severity: "warn", code: "W_LAYOUT_FORCED", message: `layout forced to ${forcedLayout}`, context: {} });
  }

  const report: ProbeCandidate[] = [];
  const survivors: { layoutClass: LayoutClass; header: HbcHeader; firstFunctionBodyOffset: number }[] = [];
  const decidedBy: string[] = [];

  // Fast v98 D-vs-E hint (§6.3), used only to annotate `decidedBy` — P1+P2 below still
  // run on every candidate and are what actually decide.
  let hint: LayoutClass | null = null;
  if (forcedLayout === undefined && version === 98) {
    const probeHeaderD = readHeaderFields(bytes, "D");
    const h = d1d2Hint(bytes, probeHeaderD);
    hint = h.hint;
    if (h.hint !== null) decidedBy.push(h.id);
  }

  for (const layoutClass of layoutCandidates) {
    const header = readHeaderFields(bytes, layoutClass);
    const p1 = probeP1(bytes, header, layoutClass);
    if (!p1.ok) {
      report.push({ layoutClass, opcodeTable: undefined, passed: false, failedProbe: "P1", ...(p1.detail !== undefined ? { detail: p1.detail } : {}) });
      continue;
    }
    const c = classLayoutConstants(layoutClass);
    const provisionalLayout: LayoutProfile = {
      layoutClass,
      version,
      opcodeTable: undefined,
      builtinTable: undefined,
      smallFuncHeaderSize: c.smallFuncHeaderSize,
      largeFuncHeaderSize: c.largeFuncHeaderSize,
      debugOffsetsSize: c.debugOffsetsSize,
      hasBigIntTable: c.hasBigIntTable,
      hasShapeTable: c.hasShapeTable,
      hasFunctionSourceTable: c.hasFunctionSourceTable,
      hasStringSwitchImms: c.hasStringSwitchImms,
      funcKindInFlags: c.funcKindInFlags,
      probe: { candidates: [], chosen: "", forced: false, decidedBy: [], exhaustive: true },
    };
    const p2 = probeP2(bytes, header, provisionalLayout);
    if (!p2.ok) {
      report.push({ layoutClass, opcodeTable: undefined, passed: false, failedProbe: "P2", ...(p2.detail !== undefined ? { detail: p2.detail } : {}) });
      continue;
    }
    report.push({ layoutClass, opcodeTable: undefined, passed: true });
    survivors.push({ layoutClass, header, firstFunctionBodyOffset: p2.firstFunctionBodyOffset! });
  }

  if (survivors.length === 0) {
    if (forcedLayout !== undefined) {
      const first = report[0];
      throw new Hbc2jsError(ErrorCode.E_LAYOUT_NO_CANDIDATE, `forced layout ${forcedLayout} failed: ${first?.detail ?? "unknown reason"}`, {});
    }
    throw new Hbc2jsError(ErrorCode.E_LAYOUT_NO_CANDIDATE, `no layout candidate for version ${version} passed P1/P2`, {});
  }
  if (survivors.length > 1) {
    // Only version 98 can reach here (D and E both structurally valid) — use the hint,
    // else refuse per D4.
    if (hint !== null) {
      const winner = survivors.find((s) => s.layoutClass === hint);
      if (winner !== undefined) {
        survivors.length = 0;
        survivors.push(winner);
      }
    }
    if (survivors.length > 1) {
      const names = survivors.map((s) => s.layoutClass).join(", ");
      throw new Hbc2jsError(ErrorCode.E_LAYOUT_AMBIGUOUS, `multiple layout classes are structurally valid: ${names}; force one with --layout`, {});
    }
  } else if (hint !== null && survivors[0]!.layoutClass !== hint) {
    // Hint disagreed with the sole P1/P2 survivor — P2 wins per §6.3 D4, but drop the
    // hint from decidedBy since it was wrong.
    decidedBy.length = 0;
  }
  if (survivors.length === 1 && decidedBy.length === 0) decidedBy.push("P2");

  const chosen = survivors[0]!;
  const c = classLayoutConstants(chosen.layoutClass);

  // --- opcode table selection ---
  const opcodeCandidates: readonly OpcodeTableId[] =
    options.opcodeTable !== undefined ? [options.opcodeTable] : candidates.opcodeTables.filter((id) => OPCODE_TABLE_LAYOUT[id] === chosen.layoutClass);
  if (options.opcodeTable !== undefined) {
    diagnostics.push({ severity: "warn", code: "W_OPCODE_TABLE_FORCED", message: `opcode table forced to ${options.opcodeTable}`, context: {} });
  }

  let chosenOpcodeTable: OpcodeTableId | undefined;
  let exhaustive = true;
  let sampledFunctions = chosen.header.functionCount;
  let totalFunctions = chosen.header.functionCount;

  if (opcodeCandidates.length === 0) {
    chosenOpcodeTable = undefined;
  } else if (opcodeCandidates.length === 1 && options.opcodeTable === undefined) {
    chosenOpcodeTable = opcodeCandidates[0];
    decidedBy.push("version");
  } else {
    const sections = buildSectionMap(chosen.header, {
      layoutClass: chosen.layoutClass,
      version,
      opcodeTable: undefined,
      builtinTable: undefined,
      smallFuncHeaderSize: c.smallFuncHeaderSize,
      largeFuncHeaderSize: c.largeFuncHeaderSize,
      debugOffsetsSize: c.debugOffsetsSize,
      hasBigIntTable: c.hasBigIntTable,
      hasShapeTable: c.hasShapeTable,
      hasFunctionSourceTable: c.hasFunctionSourceTable,
      hasStringSwitchImms: c.hasStringSwitchImms,
      funcKindInFlags: c.funcKindInFlags,
      probe: { candidates: [], chosen: "", forced: false, decidedBy: [], exhaustive: true },
    });
    const functionHeadersOffset = sections.span("functionHeaders").offset;
    const bySize = bytes.length < 2 * 1024 * 1024;
    const sample = bySize ? { indices: Array.from({ length: chosen.header.functionCount }, (_, i) => i), exhaustive: true } : probeSet(chosen.header.functionCount, chosen.header.globalCodeIndex);
    exhaustive = bySize || sample.exhaustive;
    sampledFunctions = sample.indices.length;

    const resolvedByIndex = new Map<number, { offset: number; bytecodeSizeInBytes: number }>();
    for (const i of sample.indices) {
      const rec = readFunctionRecord(bytes, functionHeadersOffset + i * c.smallFuncHeaderSize, i, chosen.layoutClass);
      resolvedByIndex.set(i, { offset: rec.header.offset, bytecodeSizeInBytes: rec.header.bytecodeSizeInBytes });
    }

    // Always validate — including a *forced* table (options.opcodeTable): T7 requires
    // `parseHbc(bytes, { opcodeTable: "wrong" })` to fail, not silently succeed.
    const tableSurvivors0 = opcodeCandidates.filter((id) => {
      const table = getOpcodeTable(id);
      for (const [, fn] of resolvedByIndex) {
        const body = bytes.subarray(fn.offset, fn.offset + fn.bytecodeSizeInBytes);
        if (!decodeForProbe(body, table, chosen.header.stringCount, chosen.header.functionCount, chosen.header.bigIntCount)) {
          return false;
        }
      }
      return true;
    });
    let tableSurvivors = tableSurvivors0;

    if (tableSurvivors.length === 0) {
      throw new Hbc2jsError(ErrorCode.E_LAYOUT_NO_CANDIDATE, `no opcode table candidate (of ${opcodeCandidates.join(", ")}) decodes the probe sample cleanly`, {});
    }
    if (tableSurvivors.length > 1 && options.opcodeTable === undefined) {
      // §6.4 warns this can happen: below opcode 165 the v98/v99 tables agree on
      // everything, so a small program that never reaches a distinguishing opcode
      // decodes cleanly under several candidates even with an EXHAUSTIVE (whole-file)
      // sample. Refusing outright here would make every tiny real v98 fixture in this
      // project's own corpus un-parseable, which the spec's own T7 requires not to
      // happen. Tie-break by preferring whichever survivor is listed first for this
      // version in candidatesForVersion() — that order is deliberately the
      // best-evidenced table first (`hbc98-late` was validated against 223 real
      // decoded function bodies from this project's own corpus with zero
      // disagreement; see docs/AGENT-LOG.md). This is NOT "prefer the newer table"
      // (spec 01 §6.4 step 3's forbidden shortcut) — hbc98-late is the *same*-version
      // table, and mar2026 (the actually newer one) loses the tie. Only applies when
      // the sample was exhaustive; an under-sampled large file still throws, per spec.
      if (exhaustive) {
        const preferred = candidates.opcodeTables.find((id) => tableSurvivors.includes(id));
        diagnostics.push({
          severity: "warn",
          code: "W_OPCODE_TABLE_TIEBREAK",
          message: `opcode tables [${tableSurvivors.join(", ")}] all decode the exhaustively-sampled file cleanly; chose ${preferred} (see docs/AGENT-LOG.md)`,
          context: {},
        });
        tableSurvivors = preferred !== undefined ? [preferred] : tableSurvivors;
        decidedBy.push("P3-tiebreak");
      }
    }
    if (tableSurvivors.length > 1) {
      throw new Hbc2jsError(
        ErrorCode.E_LAYOUT_AMBIGUOUS,
        `multiple opcode tables decode the probe sample cleanly: ${tableSurvivors.join(", ")}; force one with --opcode-table=`,
        {},
      );
    }
    chosenOpcodeTable = tableSurvivors[0];
    if (!decidedBy.includes("P3-tiebreak")) decidedBy.push("P3");
  }

  const chosenStr = chosenOpcodeTable !== undefined ? `${chosen.layoutClass}/${chosenOpcodeTable}` : `${chosen.layoutClass}/(no opcode table)`;

  return {
    layoutClass: chosen.layoutClass,
    version,
    opcodeTable: chosenOpcodeTable,
    builtinTable: chosenOpcodeTable,
    smallFuncHeaderSize: c.smallFuncHeaderSize,
    largeFuncHeaderSize: c.largeFuncHeaderSize,
    debugOffsetsSize: c.debugOffsetsSize,
    hasBigIntTable: c.hasBigIntTable,
    hasShapeTable: c.hasShapeTable,
    hasFunctionSourceTable: c.hasFunctionSourceTable,
    hasStringSwitchImms: c.hasStringSwitchImms,
    funcKindInFlags: c.funcKindInFlags,
    probe: {
      candidates: report,
      chosen: chosenStr,
      forced: forcedLayout !== undefined || options.opcodeTable !== undefined,
      decidedBy,
      exhaustive,
      sampledFunctions,
      totalFunctions,
    },
  };
}
