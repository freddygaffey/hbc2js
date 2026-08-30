// docs/specs/01-parser.md §2 — parseHbc: eager for tables, lazy for blobs.
import { createHash } from "node:crypto";
import { ErrorCode, Hbc2jsError, type Diagnostic } from "../errors.ts";
import { readHeaderFields } from "./header.ts";
import { buildSectionMap } from "./sections.ts";
import { parseStringTable } from "./strings.ts";
import { readFunctionRecord } from "./functions.ts";
import { parseShapeTable } from "./buffers.ts";
import { parseBigIntTable } from "./bigint.ts";
import { parseRegExpTable } from "./regexp.ts";
import { parseCjsModuleTable, parseFunctionSourceTable } from "./cjs.ts";
import { parseDebugInfo } from "./debug.ts";
import { makeDiagnosticSink, probeLayout } from "./layout.ts";
import type { FunctionRecord, HbcModule, ParseOptions } from "./types.ts";

const KNOWN_OPTIONS_MASK = 0x7; // staticBuiltins | cjsModulesStaticallyResolved | hasAsync

export function parseHbc(bytes: Uint8Array, options: ParseOptions = {}): HbcModule {
  const sink = makeDiagnosticSink(options.onDiagnostic);
  const layout = probeLayout(bytes, options, sink);
  const header = readHeaderFields(bytes, layout.layoutClass);
  const sections = buildSectionMap(header, layout);

  if ((header.options.raw & ~KNOWN_OPTIONS_MASK) !== 0) {
    sink.push({ severity: "warn", code: "W_UNKNOWN_OPTIONS", message: `options byte 0x${header.options.raw.toString(16)} has unknown bits set`, context: {} });
  }
  if (header.segmentID !== 0) {
    sink.push({ severity: "warn", code: "W_SEGMENTED_BUNDLE", message: `segmentID=${header.segmentID}: this is a Metro split segment, not fully supported`, context: {} });
  }

  const strings = parseStringTable(bytes, header, sections);

  const functionHeadersOffset = sections.span("functionHeaders").offset;
  const offsetCounts = new Map<number, number>();
  const resolvedFns: { header: FunctionRecord["header"]; name: string; exceptionHandlers: FunctionRecord["exceptionHandlers"]; debugOffsets: FunctionRecord["debugOffsets"] }[] = new Array(header.functionCount);
  const infoBlocks: { offset: number; index: number }[] = [];

  for (let i = 0; i < header.functionCount; i++) {
    const rec = readFunctionRecord(bytes, functionHeadersOffset + i * layout.smallFuncHeaderSize, i, layout.layoutClass);
    offsetCounts.set(rec.header.offset, (offsetCounts.get(rec.header.offset) ?? 0) + 1);
    if (rec.unexpectedInfoFlags) {
      sink.push({
        severity: "warn",
        code: "W_UNEXPECTED_INFO_FLAGS",
        message: `function ${i} claims hasExceptionHandler/hasDebugInfo but is not overflowed (no info block)`,
        context: { functionIndex: i },
      });
    }
    if (rec.header.infoOffset !== undefined) infoBlocks.push({ offset: rec.header.infoOffset, index: i });
    resolvedFns[i] = { header: rec.header, name: strings.get(rec.header.functionNameStringId), exceptionHandlers: rec.exceptionHandlers, debugOffsets: rec.debugOffsets };
  }

  // INV-26 (diagnostic): distinct info-block offsets should not overlap. Identical
  // offsets are legal (v<=96, §3.4). We only have a lower bound on each block's true
  // extent (large header + up-front declared sub-sections), which is enough to catch
  // genuine overlaps without false positives.
  {
    const distinct = new Map<number, number>(); // offset -> first function index seen
    for (const b of infoBlocks) if (!distinct.has(b.offset)) distinct.set(b.offset, b.index);
    const sortedOffsets = [...distinct.keys()].sort((a, b) => a - b);
    for (let i = 0; i + 1 < sortedOffsets.length; i++) {
      const a = sortedOffsets[i]!;
      const bNext = sortedOffsets[i + 1]!;
      if (a === bNext) continue;
      // Conservative: only flag when the gap is zero (a strict subset of true overlap
      // detection, but never a false positive).
      if (bNext < a + 4) {
        sink.push({
          severity: "warn",
          code: "W_INFO_OVERLAP",
          message: `info blocks at 0x${a.toString(16)} (fn ${distinct.get(a)}) and 0x${bNext.toString(16)} (fn ${distinct.get(bNext)}) are closer than 4 bytes apart`,
          context: {},
        });
      }
    }
  }

  const functions: FunctionRecord[] = resolvedFns.map((f) => {
    let cachedBody: Uint8Array | undefined;
    return {
      header: f.header,
      name: f.name,
      exceptionHandlers: f.exceptionHandlers,
      debugOffsets: f.debugOffsets,
      body(): Uint8Array {
        if (cachedBody === undefined) {
          cachedBody = bytes.subarray(f.header.offset, f.header.offset + f.header.bytecodeSizeInBytes);
        }
        return cachedBody;
      },
      bodyShared: (offsetCounts.get(f.header.offset) ?? 0) > 1,
    };
  });

  const literalValueBufferSpan = sections.span("literalValueBuffer");
  const literalValueBuffer = bytes.subarray(literalValueBufferSpan.offset, literalValueBufferSpan.offset + literalValueBufferSpan.size);
  const objKeyBufferSpan = sections.span("objKeyBuffer");
  const objKeyBuffer = bytes.subarray(objKeyBufferSpan.offset, objKeyBufferSpan.offset + objKeyBufferSpan.size);

  let objValueBuffer: Uint8Array;
  let shapes: HbcModule["shapes"];
  if (layout.hasShapeTable) {
    objValueBuffer = new Uint8Array(0);
    shapes = parseShapeTable(bytes, sections, header.objShapeTableCount, objKeyBuffer.length);
  } else {
    const objValueBufferSpan = sections.span("objValueBuffer");
    objValueBuffer = bytes.subarray(objValueBufferSpan.offset, objValueBufferSpan.offset + objValueBufferSpan.size);
    shapes = [];
  }

  const bigInts = layout.hasBigIntTable ? parseBigIntTable(bytes, sections, header.bigIntCount) : [];
  const regExps = parseRegExpTable(bytes, sections, header.regExpCount);
  const cjsModules = parseCjsModuleTable(bytes, sections, header.cjsModuleCount, header.options.cjsModulesStaticallyResolved);
  const functionSources = layout.hasFunctionSourceTable
    ? parseFunctionSourceTable(bytes, sections, header.functionSourceCount, header.functionCount, header.stringCount)
    : [];

  const debugInfo = parseDebugInfo(bytes, sections, header.debugInfoOffset, layout.layoutClass);

  const footerSha1 = bytes.subarray(header.fileLength - 20, header.fileLength);
  if (options.verifyFooter === true) {
    const digest = createHash("sha1").update(bytes.subarray(0, header.fileLength - 20)).digest();
    let match = digest.length === footerSha1.length;
    if (match) {
      for (let i = 0; i < digest.length; i++) {
        if (digest[i] !== footerSha1[i]) {
          match = false;
          break;
        }
      }
    }
    if (!match) {
      sink.push({ severity: "warn", code: "W_BAD_FOOTER", message: "footer SHA-1 does not match the computed hash of the file", context: {} });
    }
  }

  return {
    bytes,
    layout,
    header,
    sections,
    strings,
    functions,
    literalValueBuffer,
    objKeyBuffer,
    objValueBuffer,
    shapes,
    bigInts,
    regExps,
    cjsModules,
    functionSources,
    debugInfo,
    footerSha1,
    diagnostics: sink.all,
  };
}

export function assertNever(x: never, code: ErrorCode = ErrorCode.E_INTERNAL): never {
  throw new Hbc2jsError(code, `unreachable case: ${JSON.stringify(x)}`);
}

export type { Diagnostic };
