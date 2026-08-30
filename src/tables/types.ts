// docs/specs/00-project-skeleton.md §2 (tables/types.ts)
// docs/specs/01-parser.md §3.1, §5.4

/** Every opcode/builtin table we generate, one per (bytecodeVersion, layout-probe)
 *  candidate — see docs/specs/01-parser.md §5.2/§6.1. `hbc98-2024` and
 *  `hbc99-feb2026` have no known real fixture; they exist so the v98/v99 probe is a
 *  choice, not an assumption (D8). */
export const OpcodeTableId = {
  hbc84: "hbc84",
  hbc94: "hbc94",
  hbc96: "hbc96",
  hbc98_2024: "hbc98-2024",
  hbc98_late: "hbc98-late",
  hbc99_feb2026: "hbc99-feb2026",
  hbc99_mar2026: "hbc99-mar2026",
} as const;
export type OpcodeTableId = (typeof OpcodeTableId)[keyof typeof OpcodeTableId];

export const ALL_OPCODE_TABLE_IDS: readonly OpcodeTableId[] = [
  "hbc84",
  "hbc94",
  "hbc96",
  "hbc98-2024",
  "hbc98-late",
  "hbc99-feb2026",
  "hbc99-mar2026",
];

/** Same pinned commit as the opcode table it accompanies. */
export type BuiltinTableId = OpcodeTableId;

export type OperandTypeName = "Reg8" | "Reg32" | "UInt8" | "UInt16" | "UInt32" | "Addr8" | "Addr32" | "Imm32" | "Double";

export type OperandKind = "reg" | "uint" | "int" | "addr" | "float";

export interface OperandTypeInfo {
  readonly bytes: number;
  readonly signed: boolean;
  readonly kind: OperandKind;
}

/** What an id-shaped operand actually indexes, for range-checking and rendering. */
export type IdOperandKind = "string" | "bigint" | "function";

export interface OpcodeDef {
  readonly n: number;
  readonly name: string;
  readonly operands: readonly OperandTypeName[];
  /** 1-based operand index -> what table it indexes. Absent key = not an id operand. */
  readonly ids?: Readonly<Record<number, IdOperandKind>>;
}

export interface OpcodeTable {
  readonly id: OpcodeTableId;
  readonly bytecodeVersion: number;
  readonly hermesCommit: string;
  readonly operandTypes: Readonly<Record<OperandTypeName, OperandTypeInfo>>;
  readonly opcodes: readonly OpcodeDef[];
}

export interface BuiltinDef {
  readonly n: number;
  readonly name: string;
  readonly object?: string;
  readonly method?: string;
}

export interface BuiltinTable {
  readonly id: BuiltinTableId;
  readonly hermesCommit: string;
  readonly builtins: readonly BuiltinDef[];
}
