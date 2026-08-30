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

// D17/D17a/D17b — dependency extraction (`hbc2js deps`). `runDeps` is the
// one-call entry point; `DepsReport.moduleOwnership` is the "module id ->
// package" mapping M6's emitter (D19) needs to drop a recognised module
// from `<out>/src/` and list it in `package.json` instead.
export { runDeps, formatReportText, packageJsonDependencies } from "./deps/index.ts";
export type { DepsOptions, DepsRunResult } from "./deps/index.ts";
export type { DepsReport, ConfirmedDep, GuessedDep, UnattributedModule, ModuleOwnership } from "./deps/report.ts";
export { buildInventory, buildInventoryFromModule } from "./deps/inventory.ts";
export type { ModuleInventory, InventoryModule } from "./deps/inventory.ts";
export { matchInventory } from "./deps/match.ts";
export type { MatchReport, PackageScore, ModuleAttribution, ConfidenceTier } from "./deps/match.ts";
