// docs/specs/00-project-skeleton.md §2 (tables/registry.ts)
// docs/specs/01-parser.md §5.5 — table id -> table, selection helpers, startup asserts.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { HBC84 } from "./generated/opcodes-hbc84.ts";
import { HBC94 } from "./generated/opcodes-hbc94.ts";
import { HBC96 } from "./generated/opcodes-hbc96.ts";
import { HBC98_2024 } from "./generated/opcodes-hbc98-2024.ts";
import { HBC98_LATE } from "./generated/opcodes-hbc98-late.ts";
import { HBC99_FEB2026 } from "./generated/opcodes-hbc99-feb2026.ts";
import { HBC99_MAR2026 } from "./generated/opcodes-hbc99-mar2026.ts";
import { HBC84 as BUILTIN_HBC84 } from "./generated/builtins-hbc84.ts";
import { HBC94 as BUILTIN_HBC94 } from "./generated/builtins-hbc94.ts";
import { HBC96 as BUILTIN_HBC96 } from "./generated/builtins-hbc96.ts";
import { HBC98_2024 as BUILTIN_HBC98_2024 } from "./generated/builtins-hbc98-2024.ts";
import { HBC98_LATE as BUILTIN_HBC98_LATE } from "./generated/builtins-hbc98-late.ts";
import { HBC99_FEB2026 as BUILTIN_HBC99_FEB2026 } from "./generated/builtins-hbc99-feb2026.ts";
import { HBC99_MAR2026 as BUILTIN_HBC99_MAR2026 } from "./generated/builtins-hbc99-mar2026.ts";
import { HBC98_LATE as TYPEOFIS_HBC98_LATE } from "./generated/typeofis-hbc98-late.ts";
import { HBC99_FEB2026 as TYPEOFIS_HBC99_FEB2026 } from "./generated/typeofis-hbc99-feb2026.ts";
import { HBC99_MAR2026 as TYPEOFIS_HBC99_MAR2026 } from "./generated/typeofis-hbc99-mar2026.ts";
import { ALL_OPCODE_TABLE_IDS } from "./types.ts";
import type { BuiltinTable, OpcodeTable, OpcodeTableId, TypeOfIsTable } from "./types.ts";

const OPCODE_TABLES: Readonly<Record<OpcodeTableId, OpcodeTable>> = {
  hbc84: HBC84,
  hbc94: HBC94,
  hbc96: HBC96,
  "hbc98-2024": HBC98_2024,
  "hbc98-late": HBC98_LATE,
  "hbc99-feb2026": HBC99_FEB2026,
  "hbc99-mar2026": HBC99_MAR2026,
};

const BUILTIN_TABLES: Readonly<Record<OpcodeTableId, BuiltinTable>> = {
  hbc84: BUILTIN_HBC84,
  hbc94: BUILTIN_HBC94,
  hbc96: BUILTIN_HBC96,
  "hbc98-2024": BUILTIN_HBC98_2024,
  "hbc98-late": BUILTIN_HBC98_LATE,
  "hbc99-feb2026": BUILTIN_HBC99_FEB2026,
  "hbc99-mar2026": BUILTIN_HBC99_MAR2026,
};

/**
 * `TypeOfIs` / `JmpTypeOfIs`'s mask decoding, per table. `null` means the pin's
 * Hermes commit predates the opcode and has no `Typeof.h` to vendor — a mask at
 * such a version is `E_EMIT_UNSUPPORTED`, never a guess (spec 05 §8).
 */
const TYPEOFIS_TABLES: Readonly<Record<OpcodeTableId, TypeOfIsTable | null>> = {
  hbc84: null,
  hbc94: null,
  hbc96: null,
  "hbc98-2024": null,
  "hbc98-late": TYPEOFIS_HBC98_LATE,
  "hbc99-feb2026": TYPEOFIS_HBC99_FEB2026,
  "hbc99-mar2026": TYPEOFIS_HBC99_MAR2026,
};

function fail(id: OpcodeTableId, msg: string): never {
  throw new Hbc2jsError(ErrorCode.E_TABLE_ASSERT, `table ${id}: ${msg}`, { section: "tables/registry" });
}

/** §5.5 — properties every table must have, checked once per table (not per file). */
function assertCommon(t: OpcodeTable): void {
  if (t.opcodes[0]?.name !== "Unreachable") fail(t.id, `opcodes[0] must be "Unreachable", got ${JSON.stringify(t.opcodes[0]?.name)}`);
  const seen = new Set<string>();
  for (const op of t.opcodes) {
    if (seen.has(op.name)) fail(t.id, `duplicate opcode name ${JSON.stringify(op.name)}`);
    seen.add(op.name);
    if (op.name === "name" || op.name === "name##Long" || op.name.includes("#") || op.name.includes("...")) {
      fail(t.id, `opcode name ${JSON.stringify(op.name)} looks like a leaked macro placeholder`);
    }
    for (const operand of op.operands) {
      if (t.operandTypes[operand] === undefined) fail(t.id, `opcode ${op.name} uses unregistered operand type ${operand}`);
    }
  }
  for (let i = 0; i < t.opcodes.length; i++) {
    if (t.opcodes[i]?.n !== i) fail(t.id, `opcodes[${i}].n !== ${i} (positional numbering violated)`);
  }
}

function byName(t: OpcodeTable): Map<string, number> {
  return new Map(t.opcodes.map((o) => [o.name, o.n]));
}

function assertNames(t: OpcodeTable, expected: Readonly<Record<string, number>>): void {
  const names = byName(t);
  for (const [name, n] of Object.entries(expected)) {
    const got = names.get(name);
    if (got !== n) fail(t.id, `expected ${name}=${n}, got ${got === undefined ? "MISSING" : got}`);
  }
}

function assertLength(t: OpcodeTable, n: number): void {
  if (t.opcodes.length !== n) fail(t.id, `expected length ${n}, got ${t.opcodes.length}`);
}

function assertBuiltin(id: OpcodeTableId, name: string, n: number): void {
  const t = BUILTIN_TABLES[id];
  const found = t.builtins.find((b) => b.name === name);
  if (found === undefined || found.n !== n) {
    fail(id, `builtin ${name} expected ${n}, got ${found === undefined ? "MISSING" : found.n}`);
  }
}

let verified = false;

/** Runs every §5.5 assertion once. Called automatically by getOpcodeTable /
 *  getBuiltinTable; safe to call again (idempotent). */
export function verifyTables(): void {
  if (verified) return;

  for (const id of ALL_OPCODE_TABLE_IDS) assertCommon(OPCODE_TABLES[id]);

  assertLength(OPCODE_TABLES.hbc84, 185);

  assertLength(OPCODE_TABLES.hbc94, 192);
  assertNames(OPCODE_TABLES.hbc94, {
    DeclareGlobalVar: 52,
    GetGlobalObject: 48,
    CreateEnvironment: 50,
    PutById: 59,
    CreateAsyncClosure: 104,
    Ret: 92,
    Catch: 93,
    CreateRegExp: 132,
    SwitchImm: 133,
  });
  assertBuiltin("hbc94", "spawnAsync", 52);

  assertLength(OPCODE_TABLES.hbc96, 192);
  assertNames(OPCODE_TABLES.hbc96, {
    DeclareGlobalVar: 52,
    GetGlobalObject: 48,
    CreateEnvironment: 50,
    PutById: 59,
    CreateAsyncClosure: 104,
    Ret: 92,
    Catch: 93,
    CreateRegExp: 132,
    SwitchImm: 133,
    DirectEval: 94,
  });
  {
    const directEval = OPCODE_TABLES.hbc96.opcodes.find((o) => o.name === "DirectEval");
    if (directEval === undefined || directEval.operands.length !== 3) {
      fail("hbc96", `DirectEval must take 3 operands (Reg8, Reg8, UInt8), got ${JSON.stringify(directEval?.operands)}`);
    }
  }

  assertLength(OPCODE_TABLES["hbc98-2024"], 201);

  assertLength(OPCODE_TABLES["hbc98-late"], 219);
  assertNames(OPCODE_TABLES["hbc98-late"], {
    CreateFunctionEnvironment: 64,
    DeclareGlobalVar: 67,
    GetGlobalObject: 61,
    PutByIdLoose: 74,
    CreateClosure: 132,
    CreateRegExp: 165,
    UIntSwitchImm: 166,
    StringSwitchImm: 167,
  });
  if (byName(OPCODE_TABLES["hbc98-late"]).has("NewTypedObjectWithBuffer")) {
    fail("hbc98-late", "NewTypedObjectWithBuffer must be absent");
  }

  assertLength(OPCODE_TABLES["hbc99-feb2026"], 219);

  assertLength(OPCODE_TABLES["hbc99-mar2026"], 220);
  assertNames(OPCODE_TABLES["hbc99-mar2026"], {
    GetParentEnvironment: 52,
    GetGlobalObject: 61,
    CreateFunctionEnvironment: 64,
    CreateTopLevelEnvironment: 65,
    DeclareGlobalVar: 67,
    GetByIdShort: 68,
    TryGetById: 72,
    PutByIdLoose: 74,
    Ret: 118,
    Catch: 119,
    CreateClosure: 132,
    CreateRegExp: 166,
    UIntSwitchImm: 167,
    StringSwitchImm: 168,
    CreateGenerator: 169,
  });
  if (byName(OPCODE_TABLES["hbc99-mar2026"]).get("NewTypedObjectWithBuffer") !== 4) {
    fail("hbc99-mar2026", "NewTypedObjectWithBuffer must be opcode 4");
  }
  assertBuiltin("hbc99-mar2026", "spawnAsync", 57);

  verified = true;
}

export function getOpcodeTable(id: OpcodeTableId): OpcodeTable {
  verifyTables();
  return OPCODE_TABLES[id];
}

export function getBuiltinTable(id: OpcodeTableId): BuiltinTable {
  verifyTables();
  return BUILTIN_TABLES[id];
}

/** The `TypeOfIsTypes` bit order for a table, or `null` where the opcode does
 *  not exist at that pin. */
export function getTypeOfIsTable(id: OpcodeTableId): TypeOfIsTable | null {
  verifyTables();
  return TYPEOFIS_TABLES[id];
}

export function listOpcodeTableIds(): readonly OpcodeTableId[] {
  return ALL_OPCODE_TABLE_IDS;
}
