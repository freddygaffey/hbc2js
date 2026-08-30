// docs/specs/03-cfg.md §3 — CFG, exception-region and environment-graph types.
// Every interface is fully readonly (spec 00 §5 "Immutability").
import type { Diagnostic } from "../errors.ts";
import type { Instruction, SwitchTable } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";

// ---------------------------------------------------------------------------
// §3.1 Blocks and edges
// ---------------------------------------------------------------------------

export type BlockId = number; // dense, 0-based; the ENTRY is cfg.entry, not always 0

export type EdgeKind =
  | "fallthrough" // straight-line continuation
  | "jump" // unconditional Jmp/JmpLong
  | "branch-taken" // conditional jump, condition holds
  | "branch-not-taken" // conditional jump, fallthrough
  | "switch-case" // one jump-table entry
  | "switch-default"; // the switch's default target

export interface Edge {
  readonly from: BlockId;
  readonly to: BlockId;
  readonly kind: EdgeKind;
  /** switch-case only: the integer case value, or the case-label string id. */
  readonly caseValue?: number;
  /** switch-case only: true when caseValue indexes the string table. */
  readonly caseIsString?: boolean;
}

export type BlockTerminator =
  | { readonly kind: "fallthrough" }
  | { readonly kind: "jump" }
  | { readonly kind: "branch" }
  | { readonly kind: "switch"; readonly table: SwitchTable; readonly synthetic?: true }
  | { readonly kind: "return" }
  | { readonly kind: "throw" }
  | { readonly kind: "unreachable" };

export interface BasicBlock {
  readonly id: BlockId;
  /** Function-relative offset, inclusive. `-1` for the §4.5 synthetic block. */
  readonly start: number;
  /** Function-relative offset, exclusive. `-1` for the §4.5 synthetic block. */
  readonly end: number;
  readonly instructions: readonly Instruction[];
  readonly terminator: BlockTerminator;
  /** NORMAL edges only — never exception edges (CFG-03). */
  readonly succs: readonly Edge[];
  readonly preds: readonly BlockId[];
  readonly isHandlerEntry: boolean;
  readonly catchRegister?: number;
}

// ---------------------------------------------------------------------------
// §3.2 Function CFG
// ---------------------------------------------------------------------------

export interface DominatorTree {
  readonly idom: readonly (BlockId | null)[];
  readonly children: readonly (readonly BlockId[])[];
  dominates(a: BlockId, b: BlockId): boolean;
  readonly preorder: readonly BlockId[];
  readonly backEdges: readonly (readonly [BlockId, BlockId])[];
}

// ---------------------------------------------------------------------------
// §3.3 Exception regions
// ---------------------------------------------------------------------------

export interface ExceptionRegion {
  readonly index: number;
  readonly startPc: number;
  readonly endPc: number; // EXCLUSIVE
  readonly handlerBlock: BlockId;
  readonly catchRegister: number;
  readonly bodyBlocks: ReadonlySet<BlockId>;
  readonly parent: number | null;
  readonly children: readonly number[];
  readonly sharesHandlerWith: readonly number[];
}

// ---------------------------------------------------------------------------
// §3.4 Generators and async
// ---------------------------------------------------------------------------

export type FunctionKind = "normal" | "generator" | "async" | "async-generator";
export type GeneratorEra = "none" | "opcode" | "lowered";

export interface FunctionKindInfo {
  readonly functionIndex: number;
  readonly kind: FunctionKind;
  readonly era: GeneratorEra;
  readonly evidence: readonly ("header" | "creation-site" | "body")[];
  readonly innerFunctionIndex: number | null;
  readonly trampolineFunctionIndex: number | null;
  readonly shimRequired: boolean;
}

export interface SuspendPoint {
  /** 1-based resume state. State 0 is the function's real entry. */
  readonly state: number;
  readonly saveOffset: number;
  readonly resumeBlock: BlockId;
  readonly canonical: boolean;
  readonly retRegister: number | null;
}

export interface GeneratorShape {
  readonly info: FunctionKindInfo;
  readonly resumeDispatch: BlockId | null;
  readonly suspendPoints: readonly SuspendPoint[];
  readonly generatorOps: readonly { readonly offset: number; readonly name: string }[];
}

export interface FunctionCfg {
  readonly functionIndex: number;
  readonly blocks: readonly BasicBlock[]; // index === BlockId
  readonly entry: BlockId;
  readonly exits: readonly BlockId[];
  readonly byOffset: ReadonlyMap<number, BlockId>;
  readonly exceptionSuccs: ReadonlyMap<BlockId, readonly BlockId[]>;
  readonly regions: readonly ExceptionRegion[];
  readonly switchTables: readonly SwitchTable[];
  readonly dom: DominatorTree;
  readonly rpo: readonly BlockId[];
  readonly reducible: boolean;
  readonly generator: GeneratorShape;
  readonly frameSize: number;
  readonly paramCount: number;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// §3.5 Environment / closure graph
// ---------------------------------------------------------------------------

export type EnvNodeId = number;

export interface EnvNode {
  readonly id: EnvNodeId;
  readonly ownerFunction: number;
  readonly createOffset: number;
  readonly createOpcode: string;
  readonly parent: EnvNodeId | null;
  readonly size: number;
  readonly closures: readonly number[];
}

export type EnvAccessKind = "load" | "store";

export interface EnvAccess {
  readonly functionIndex: number;
  readonly offset: number;
  readonly kind: EnvAccessKind;
  readonly slot: number;
  readonly env: EnvNodeId | null;
  readonly unresolvedReason?: "dynamic-closure-env" | "unknown-depth" | "reg-not-tracked";
}

export interface EnvSlot {
  readonly env: EnvNodeId;
  readonly slot: number;
  readonly accesses: readonly EnvAccess[];
  readonly readers: ReadonlySet<number>;
  readonly writers: ReadonlySet<number>;
  readonly strategy: "lexical" | "materialised";
}

export interface EnvGraph {
  readonly nodes: readonly EnvNode[];
  readonly slots: readonly EnvSlot[];
  slot(env: EnvNodeId, slot: number): EnvSlot | undefined;
  readonly closureEnvOf: ReadonlyMap<number, EnvNodeId | null>;
  readonly envsCreatedIn: ReadonlyMap<number, readonly EnvNodeId[]>;
  /** (functionIndex, offset) -> the resolved env for that access site. */
  readonly resolvedAt: ReadonlyMap<string, EnvNodeId>;
  readonly unresolved: readonly EnvAccess[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Key for `EnvGraph.resolvedAt`. */
export function siteKey(functionIndex: number, offset: number): string {
  return `${functionIndex}:${offset}`;
}

// ---------------------------------------------------------------------------
// §2 Public API shapes
// ---------------------------------------------------------------------------

export interface AnalysisOptions {
  /** Fail instead of falling back to a materialised environment object. Default true. */
  readonly strictEnv?: boolean;
  /** Cap on blocks per function before we refuse (obfuscated input; §8). */
  readonly maxBlocks?: number;
  /** Run the CFG invariant checks (CFG-01..19). Default true. */
  readonly checkInvariants?: boolean;
  /** Testing hook: skip §4.5's resume dispatcher so CFG-05 can be shown to fire. */
  readonly disableResumeDispatch?: boolean;
}

export interface ModuleAnalysis {
  readonly module: HbcModule;
  readonly envGraph: EnvGraph;
  readonly kinds: readonly FunctionKindInfo[];
  cfg(functionIndex: number): FunctionCfg;
  decoded(functionIndex: number): import("../disasm/decode.ts").DecodedFunction;
  readonly options: Required<Pick<AnalysisOptions, "strictEnv" | "maxBlocks" | "checkInvariants">>;
  readonly diagnostics: readonly Diagnostic[];
}
