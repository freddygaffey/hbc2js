// docs/specs/01-parser.md §4 — section offset computation by walking the serializer
// order. Only debugInfoOffset is stored in the header; everything else is computed.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { HEADER_SIZE } from "./header.ts";
import type { HbcHeader, LayoutProfile, SectionMap, SectionName, SectionSpan } from "./types.ts";

const ALIGN = 4;

export function alignUp(x: number, align: number): number {
  const rem = x % align;
  return rem === 0 ? x : x + (align - rem);
}

export function buildSectionMap(header: HbcHeader, layout: LayoutProfile): SectionMap {
  const spans: SectionSpan[] = [{ name: "header", offset: 0, size: HEADER_SIZE }];
  let o = HEADER_SIZE;

  const span = (name: SectionName, size: number): void => {
    const offset = alignUp(o, ALIGN);
    if (offset < 0 || offset > header.fileLength || size < 0 || offset + size > header.fileLength) {
      throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `section ${name} [${offset}, ${offset + size}) exceeds fileLength ${header.fileLength}`, {
        offset,
        section: name,
      });
    }
    spans.push({ name, offset, size });
    o = offset + size;
  };

  span("functionHeaders", header.functionCount * layout.smallFuncHeaderSize);
  span("stringKinds", header.stringKindCount * 4);
  span("identifierHashes", header.identifierCount * 4);
  span("smallStringTable", header.stringCount * 4);
  span("overflowStringTable", header.overflowStringCount * 8);
  span("stringStorage", header.stringStorageSize);
  span("literalValueBuffer", header.literalValueBufferSize);
  span("objKeyBuffer", header.objKeyBufferSize);
  if (layout.hasShapeTable) {
    span("objShapeTable", header.objShapeTableCount * 8);
  } else {
    span("objValueBuffer", header.objValueBufferSize);
  }
  if (layout.hasBigIntTable) {
    span("bigIntTable", header.bigIntCount * 8);
    span("bigIntStorage", header.bigIntStorageSize);
  }
  span("regExpTable", header.regExpCount * 8);
  span("regExpStorage", header.regExpStorageSize);
  span("cjsModuleTable", header.cjsModuleCount * 8);
  if (layout.hasFunctionSourceTable) {
    span("functionSourceTable", header.functionSourceCount * 8);
  }

  const firstFunctionBodyOffset = alignUp(o, ALIGN);

  const debugInfoOffset = header.debugInfoOffset !== 0 ? header.debugInfoOffset : header.fileLength - 20;
  spans.push({ name: "functionBodies", offset: firstFunctionBodyOffset, size: Math.max(0, debugInfoOffset - firstFunctionBodyOffset) });
  spans.push({ name: "functionInfo", offset: firstFunctionBodyOffset, size: Math.max(0, debugInfoOffset - firstFunctionBodyOffset) });
  if (header.debugInfoOffset !== 0) {
    spans.push({ name: "debugInfo", offset: header.debugInfoOffset, size: Math.max(0, header.fileLength - 20 - header.debugInfoOffset) });
  } else {
    spans.push({ name: "debugInfo", offset: header.fileLength - 20, size: 0 });
  }
  spans.push({ name: "footer", offset: header.fileLength - 20, size: 20 });

  const byName = new Map(spans.map((s) => [s.name, s] as const));

  return {
    span(name: SectionName): SectionSpan {
      const s = byName.get(name);
      if (s === undefined) {
        throw new Hbc2jsError(ErrorCode.E_INTERNAL, `section ${name} not present in this file's section map`, { section: name });
      }
      return s;
    },
    all: spans,
    firstFunctionBodyOffset,
  };
}
