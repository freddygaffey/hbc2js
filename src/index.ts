// docs/specs/00-project-skeleton.md §2 — public API barrel.
export { parseHbc } from "./parse/module.ts";
export type {
  BigIntEntry,
  CjsModuleEntry,
  DebugFileRegion,
  DebugInfo,
  DebugOffsets,
  ExceptionHandler,
  FuncKind,
  FunctionFlags,
  FunctionHeader,
  FunctionRecord,
  FunctionSourceEntry,
  HbcHeader,
  HbcModule,
  HbcOptions,
  LayoutProfile,
  LiteralRun,
  ObjectShape,
  ParseOptions,
  ProbeCandidate,
  ProbeReport,
  ProhibitInvoke,
  RegExpEntry,
  SectionMap,
  SectionName,
  SectionSpan,
  SerializedLiteral,
  StringEntry,
  StringKind,
  StringTable,
  TableRef,
} from "./parse/types.ts";
export { LayoutClass } from "./parse/types.ts";
export type { BuiltinTableId, OpcodeTableId } from "./parse/types.ts";
export { ErrorCode, Hbc2jsError, ParseError, DecodeError } from "./errors.ts";
export type { Diagnostic, ErrorContext, Severity } from "./errors.ts";
export { VERSION } from "./version.ts";
