// docs/specs/01-parser.md §3.6; docs/HBC-FORMAT.md §9.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { BinaryReader } from "../util/reader.ts";
import type { CjsModuleEntry, FunctionSourceEntry, SectionMap } from "./types.ts";

export function parseCjsModuleTable(bytes: Uint8Array, sections: SectionMap, cjsModuleCount: number, staticallyResolved: boolean): readonly CjsModuleEntry[] {
  const span = sections.span("cjsModuleTable");
  const r = new BinaryReader(bytes.subarray(span.offset, span.offset + span.size), "cjsModuleTable");
  const entries: CjsModuleEntry[] = new Array(cjsModuleCount);
  for (let i = 0; i < cjsModuleCount; i++) {
    const first = r.u32();
    const second = r.u32();
    entries[i] = { index: i, first, second, resolved: staticallyResolved };
  }
  return entries;
}

export function parseFunctionSourceTable(
  bytes: Uint8Array,
  sections: SectionMap,
  functionSourceCount: number,
  functionCount: number,
  stringCount: number,
): readonly FunctionSourceEntry[] {
  const span = sections.span("functionSourceTable");
  const r = new BinaryReader(bytes.subarray(span.offset, span.offset + span.size), "functionSourceTable");
  const entries: FunctionSourceEntry[] = new Array(functionSourceCount);
  for (let i = 0; i < functionSourceCount; i++) {
    const functionIndex = r.u32();
    const stringId = r.u32();
    if (functionIndex >= functionCount) {
      throw new Hbc2jsError(ErrorCode.E_BAD_FUNCTION_ID, `functionSourceTable[${i}].functionIndex=${functionIndex} >= functionCount ${functionCount}`, {
        section: "functionSourceTable",
      });
    }
    if (stringId >= stringCount) {
      throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `functionSourceTable[${i}].stringId=${stringId} >= stringCount ${stringCount}`, {
        section: "functionSourceTable",
      });
    }
    entries[i] = { index: i, functionIndex, stringId };
  }
  return entries;
}
