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

/** Semantic annotation harvested from BytecodeList.def's OPERAND_*_ID macros
 *  (spec 01 §5.4 rule 7) plus a hand-written override table (src/tables/roles.ts)
 *  for the operand kinds those macros don't cover. docs/specs/02-disassembler.md
 *  §3.1/§3.4. `envSlot` is declared for forward compatibility (an environment
 *  slot index, e.g. LoadFromEnvironment's UInt8) but §3.4's rule list never
 *  actually assigns it — those operands fall through to "imm" today; a future
 *  spec revision would need to add the rule before this role is ever produced. */
export type OperandRole = "reg" | "imm" | "double" | "addr" | "string" | "function" | "bigint" | "regexp" | "cacheIndex" | "builtin" | "shape" | "literalOffset" | "envSlot";

export interface OpcodeDef {
  readonly n: number;
  readonly name: string;
  readonly operands: readonly OperandTypeName[];
  /** 1-based operand index -> what table it indexes. Absent key = not an id operand. */
  readonly ids?: Readonly<Record<number, IdOperandKind>>;
  /** True for a table entry whose existence is inferred but whose real name/operand
   *  signature has never been confirmed. Not currently set on any generated table —
   *  `hbc98-late`'s one inferred opcode was originally shipped this way
   *  (`UnknownFastArrayOpcode98Late`, guessed `(Reg8, Reg8)`) until M1 review
   *  Finding 2 flagged the guess; fixing decoders to fail loudly on it surfaced a
   *  real fixture that hits it, which led to identifying the real opcode
   *  (`CacheNewObject`) from Hermes' own commit history instead — see
   *  tools/gen-tables/gen.ts's `patchHbc98Late`. Kept as a mechanism for any future
   *  such gap: any decoder that reaches an `unverified` opcode must fail loudly
   *  (E_UNKNOWN_OPCODE) rather than guess a signature — D8/R1: a silently wrong parse
   *  is worse than an honest refusal. `operands` should be `[]` for such an entry;
   *  it is never actually consumed. */
  readonly unverified?: true;
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

/**
 * `TypeOfIs` / `JmpTypeOfIs`'s mask operand, from
 * `include/hermes/FrontEndDefs/Typeof.h`'s `HERMES_TYPEOF_IS_TYPES` macro list.
 * `TypeOfIsTypes` is a `uint16_t` bitset whose bit *i* is the *i*-th name in
 * declaration order, so the macro list IS the table: `types[i]` is bit `i`.
 * There is no "negate" flag — a `!==` test is compiled as the complement mask.
 *
 * Only pins whose Hermes commit has the opcode carry the header (v98-late on).
 */
export interface TypeOfIsTable {
  readonly id: OpcodeTableId;
  readonly hermesCommit: string;
  /** Bit order, index = bit position. */
  readonly types: readonly string[];
}
