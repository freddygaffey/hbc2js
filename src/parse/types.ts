// docs/specs/01-parser.md §2, §3 — parser public types. Field names mirror
// docs/HBC-FORMAT.md. All interfaces are fully readonly.
import type { Diagnostic } from "../errors.ts";

export type { BuiltinTableId, OpcodeTableId } from "../tables/types.ts";
import type { BuiltinTableId, OpcodeTableId } from "../tables/types.ts";

export const LayoutClass = { A: "A", B: "B", C: "C", D: "D", E: "E" } as const;
export type LayoutClass = (typeof LayoutClass)[keyof typeof LayoutClass];

export interface LayoutProfile {
  readonly layoutClass: LayoutClass;
  readonly version: number;
  /** `undefined` when the version/layout parses but no opcode table has been
   *  generated for it (e.g. v85/86, v97 — spec 01 §6.1). Decoding then fails with
   *  E_UNSUPPORTED_VERSION, but the rest of the module is still valid — deliberate
   *  deviation from spec 01 §3.1's non-optional field, needed to make that documented
   *  behaviour representable. */
  readonly opcodeTable: OpcodeTableId | undefined;
  readonly builtinTable: BuiltinTableId | undefined;
  readonly smallFuncHeaderSize: 12 | 16;
  readonly largeFuncHeaderSize: 23 | 31 | 36 | 37;
  readonly debugOffsetsSize: 4 | 8 | 12;
  readonly hasBigIntTable: boolean;
  readonly hasShapeTable: boolean;
  readonly hasFunctionSourceTable: boolean;
  readonly hasStringSwitchImms: boolean;
  readonly funcKindInFlags: boolean;
  readonly probe: ProbeReport;
}

export interface ProbeReport {
  readonly candidates: readonly ProbeCandidate[];
  readonly chosen: string;
  readonly forced: boolean;
  readonly decidedBy: readonly string[];
  readonly exhaustive: boolean;
  readonly sampledFunctions?: number;
  readonly totalFunctions?: number;
  /** Exact function indices included in a non-exhaustive P3 probe sample (§6.4 /
   *  M1 follow-up). `undefined` when `exhaustive` is true (every function was
   *  checked, so "was N sampled" is trivially true for all N) or when the sample
   *  loop never ran (opcode table was unambiguous). Lets a consumer — e.g. spec
   *  02 §3.3's decoder hint — ask "was *this* function index in the sample?"
   *  exactly, instead of approximating from `sampledFunctions`/`totalFunctions`
   *  counts alone. See `wasSampled` in parse/layout.ts. */
  readonly sampledIndices?: readonly number[];
}

export interface ProbeCandidate {
  readonly layoutClass: LayoutClass;
  /** `undefined` for candidates eliminated at P1/P2, before any opcode table was
   *  tried (deviation from spec 01 §3.1, see LayoutProfile.opcodeTable). */
  readonly opcodeTable: OpcodeTableId | undefined;
  readonly passed: boolean;
  readonly failedProbe?: string;
  readonly detail?: string;
}

export interface HbcOptions {
  readonly staticBuiltins: boolean;
  readonly cjsModulesStaticallyResolved: boolean;
  readonly hasAsync: boolean;
  readonly raw: number;
}

export interface HbcHeader {
  readonly magic: bigint;
  readonly version: number;
  readonly sourceHash: Uint8Array;
  readonly fileLength: number;
  readonly globalCodeIndex: number;
  readonly functionCount: number;
  readonly stringKindCount: number;
  readonly identifierCount: number;
  readonly stringCount: number;
  readonly overflowStringCount: number;
  readonly stringStorageSize: number;
  readonly bigIntCount: number;
  readonly bigIntStorageSize: number;
  readonly regExpCount: number;
  readonly regExpStorageSize: number;
  readonly literalValueBufferSize: number;
  readonly objKeyBufferSize: number;
  readonly objValueBufferSize: number;
  readonly objShapeTableCount: number;
  readonly numStringSwitchImms: number;
  readonly segmentID: number;
  readonly cjsModuleCount: number;
  readonly functionSourceCount: number;
  readonly debugInfoOffset: number;
  readonly options: HbcOptions;
}

export type StringKind = "String" | "Identifier";

export interface StringEntry {
  readonly id: number;
  readonly kind: StringKind;
  readonly isUTF16: boolean;
  readonly storageOffset: number;
  readonly length: number;
  readonly overflowed: boolean;
}

export interface StringTable {
  readonly count: number;
  readonly identifierCount: number;
  entry(id: number): StringEntry;
  get(id: number): string;
  kind(id: number): StringKind;
  identifierHash(id: number): number | undefined;
  readonly storage: Uint8Array;
}

export type ProhibitInvoke = "call" | "construct" | "none";
export type FuncKind = "Normal" | "Generator" | "Async";

export interface FunctionFlags {
  readonly prohibitInvoke: ProhibitInvoke;
  readonly strictMode: boolean;
  readonly hasExceptionHandler: boolean;
  readonly hasDebugInfo: boolean;
  readonly overflowed: boolean;
  readonly kind: FuncKind;
  readonly kindKnown: boolean;
  readonly raw: number;
}

export interface FunctionHeader {
  readonly index: number;
  readonly offset: number;
  readonly paramCount: number;
  readonly bytecodeSizeInBytes: number;
  readonly functionNameStringId: number;
  readonly frameSize: number;
  readonly infoOffset: number | undefined;
  readonly environmentSize: number | undefined;
  readonly loopDepth: number | undefined;
  readonly numberRegCount: number | undefined;
  readonly nonPtrRegCount: number | undefined;
  readonly readCacheSize: number;
  readonly writeCacheSize: number;
  readonly privateNameCacheSize: number | undefined;
  readonly flags: FunctionFlags;
  readonly fromLargeHeader: boolean;
}

export interface ExceptionHandler {
  readonly start: number;
  readonly end: number;
  readonly target: number;
}

export interface DebugOffsets {
  readonly sourceLocations: number | null;
  readonly lexicalData: number | null;
  readonly scopeDescData: number | null;
  readonly textifiedCallees: number | null;
}

export interface FunctionRecord {
  readonly header: FunctionHeader;
  readonly name: string;
  readonly exceptionHandlers: readonly ExceptionHandler[];
  readonly debugOffsets: DebugOffsets | null;
  body(): Uint8Array;
  readonly bodyShared: boolean;
}

export type SerializedLiteral =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "string"; readonly stringId: number }
  /** Tag 6 at v≥97 (`UndefinedTag`, no payload) — docs/HBC-FORMAT.md §6.3.
   *  Only produced when `readLiterals` is given a version ≥ 97. */
  | { readonly kind: "undefined" };

export interface LiteralRun {
  readonly offset: number;
  readonly tag: number;
  readonly count: number;
  readonly byteLength: number;
}

export interface ObjectShape {
  readonly index: number;
  readonly keyBufferOffset: number;
  readonly numProps: number;
}

export interface TableRef {
  readonly offset: number;
  readonly length: number;
}

export interface BigIntEntry extends TableRef {
  readonly index: number;
  value(): bigint;
  readonly bytes: Uint8Array;
}

export interface RegExpEntry extends TableRef {
  readonly index: number;
  readonly bytes: Uint8Array;
}

export interface CjsModuleEntry {
  readonly index: number;
  readonly first: number;
  readonly second: number;
  readonly resolved: boolean;
}

export interface FunctionSourceEntry {
  readonly index: number;
  readonly functionIndex: number;
  readonly stringId: number;
}

export interface DebugFileRegion {
  readonly fromAddress: number;
  readonly filenameId: number;
  readonly sourceMappingUrlId: number;
}

export interface DebugInfo {
  readonly offset: number;
  readonly filenameCount: number;
  readonly filenameStorageSize: number;
  readonly fileRegionCount: number;
  readonly scopeDescDataOffset: number | null;
  readonly textifiedCalleeOffset: number | null;
  readonly stringTableOffset: number | null;
  readonly debugDataSize: number;
  readonly filenames: readonly string[];
  readonly fileRegions: readonly DebugFileRegion[];
  readonly data: Uint8Array;
}

export type SectionName =
  | "header"
  | "functionHeaders"
  | "stringKinds"
  | "identifierHashes"
  | "smallStringTable"
  | "overflowStringTable"
  | "stringStorage"
  | "literalValueBuffer"
  | "objKeyBuffer"
  | "objValueBuffer"
  | "objShapeTable"
  | "bigIntTable"
  | "bigIntStorage"
  | "regExpTable"
  | "regExpStorage"
  | "cjsModuleTable"
  | "functionSourceTable"
  | "functionBodies"
  | "functionInfo"
  | "debugInfo"
  | "footer";

export interface SectionSpan {
  readonly name: SectionName;
  readonly offset: number;
  readonly size: number;
}

export interface SectionMap {
  span(name: SectionName): SectionSpan;
  readonly all: readonly SectionSpan[];
  readonly firstFunctionBodyOffset: number;
}

export interface HbcModule {
  readonly bytes: Uint8Array;
  readonly layout: LayoutProfile;
  readonly header: HbcHeader;
  readonly sections: SectionMap;
  readonly strings: StringTable;
  readonly functions: readonly FunctionRecord[];
  readonly literalValueBuffer: Uint8Array;
  readonly objKeyBuffer: Uint8Array;
  readonly objValueBuffer: Uint8Array;
  readonly shapes: readonly ObjectShape[];
  readonly bigInts: readonly BigIntEntry[];
  readonly regExps: readonly RegExpEntry[];
  readonly cjsModules: readonly CjsModuleEntry[];
  readonly functionSources: readonly FunctionSourceEntry[];
  readonly debugInfo: DebugInfo | null;
  readonly footerSha1: Uint8Array | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ParseOptions {
  readonly layout?: LayoutClass;
  readonly opcodeTable?: OpcodeTableId;
  readonly verifyFooter?: boolean;
  readonly onDiagnostic?: (d: Diagnostic) => void;
  readonly maxBodyBytes?: number;
}
