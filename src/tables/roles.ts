// docs/specs/02-disassembler.md §3.4 — operand role assignment, encoded as data
// (not `if` chains in the decoder). Roles come from the generated table's `ids`
// map (OPERAND_STRING_ID / OPERAND_BIGINT_ID / OPERAND_FUNCTION_ID macros, spec 01
// §5.4 rule 7), merged with a small hand-written override table for the operand
// kinds those macros don't cover (regexp/shape/literalOffset/builtin/cacheIndex).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { getOpcodeTable, listOpcodeTableIds } from "./registry.ts";
import type { OpcodeDef, OpcodeTable, OperandRole, OperandTypeName } from "./types.ts";

const DEFAULT_ROLE_BY_TYPE: Readonly<Record<OperandTypeName, OperandRole>> = {
  Reg8: "reg",
  Reg32: "reg",
  Addr8: "addr",
  Addr32: "addr",
  Double: "double",
  Imm32: "imm",
  UInt8: "imm",
  UInt16: "imm",
  UInt32: "imm",
};

const ID_KIND_TO_ROLE: Readonly<Record<string, OperandRole>> = {
  string: "string",
  bigint: "bigint",
  function: "function",
};

/**
 * Hand-written overrides for operand roles the generated `ids` map cannot
 * express (docs/specs/02-disassembler.md §3.4). Keyed by
 * `${opcodeName}#${operandCount}` — 1-based operand index -> role, matching
 * `OpcodeDef.ids`'s indexing convention.
 *
 * The arity suffix exists because a handful of opcodes keep the same name but
 * change their operand *shape* across the v96/v97 literal-buffer redesign
 * (docs/HBC-FORMAT.md §6): `NewObjectWithBuffer[Long]` is
 * `(dest, sizeHint, numStaticElements, objKeyBufferIdx, objValBufferIdx)` at
 * v<=96 (5 operands) and `(dest, shapeTableIdx, valueBufferOffset)` at v>=97 (3
 * operands) — two real, distinct encodings under one name, not one shape with
 * an optional field. Verified against the vendored `BytecodeList.def` comments
 * in every `third_party/hermes/<id>/` directory (cited per-entry below).
 *
 * cacheIndex coverage is intentionally wider than spec 02 §3.4's literal
 * "GetById / GetByIdShort / PutById* / TryGetById / TryPutById*" list: the
 * vendored source documents the identical "Arg3 is a cache index" shape for
 * `DefineOwnById[Long]` and `GetByIdWithReceiverLong` (both v98+), which that
 * wildcard list doesn't literally spell out but which are real, verified
 * instances of the same idiom (see e.g.
 * third_party/hermes/hbc99-mar2026/BytecodeList.def, DefineOwnById's doc
 * comment). Included here rather than left as "imm" because getting this
 * right matters for M4's "the emitter must ignore it" contract.
 */
const ROLE_OVERRIDES: Readonly<Record<string, Readonly<Record<number, OperandRole>>>> = {
  // v<=96: (dest, sizeHint, numStaticElements, objKeyBufferIdx, objValBufferIdx).
  // third_party/hermes/hbc94/BytecodeList.def, NewObjectWithBuffer doc comment.
  "NewObjectWithBuffer#5": { 4: "literalOffset", 5: "literalOffset" },
  "NewObjectWithBufferLong#5": { 4: "literalOffset", 5: "literalOffset" },
  // v>=97: (dest, shapeTableIdx, valueBufferOffset).
  // third_party/hermes/hbc98-late/BytecodeList.def, NewObjectWithBuffer doc comment.
  "NewObjectWithBuffer#3": { 2: "shape", 3: "literalOffset" },
  "NewObjectWithBufferLong#3": { 2: "shape", 3: "literalOffset" },
  // v>=98: (dest, parent, shapeTableIdx, valueBufferOffset).
  "NewObjectWithBufferAndParent#4": { 3: "shape", 4: "literalOffset" },
  // both eras: (dest, sizeHint, numStaticElements, arrayBufferIdx/Offset) — the
  // buffer-index operand stays the last operand across the v97 redesign.
  "NewArrayWithBuffer#4": { 4: "literalOffset" },
  "NewArrayWithBufferLong#4": { 4: "literalOffset" },
  // (dest, patternStringId[ids: string], flagsStringId[ids: string], regExpTableIdx).
  // The generator's OPERAND_STRING_ID pass already tags operands 2/3; operand 4
  // (the regexp-table index) isn't a *_ID macro, so it needs the override.
  "CreateRegExp#4": { 4: "regexp" },
  // v84 has no OPERAND_FUNCTION_ID macro at all (introduced later in Hermes'
  // history — third_party/hermes/hbc84/BytecodeList.def defines no such macro,
  // confirmed by its total absence, vs. hbc94's `#define OPERAND_FUNCTION_ID`).
  // These 9 opcodes' 3rd operand is a function-table index at every version
  // that *does* tag it (v94+); real `hbc-disassembler` output confirms it's a
  // `function_id` at v84 too (tests/gate/oracle/disasm/hermes-dec.test.ts).
  // `CallDirectLongIndex` is never tagged at *any* version (a permanent gap in
  // Hermes' own annotations — verified in hbc94/hbc99-mar2026 too) but shares
  // `CallDirect`'s exact semantics, just with a wider index encoding.
  "CreateClosure#3": { 3: "function" },
  "CreateClosureLongIndex#3": { 3: "function" },
  "CreateGeneratorClosure#3": { 3: "function" },
  "CreateGeneratorClosureLongIndex#3": { 3: "function" },
  "CreateAsyncClosure#3": { 3: "function" },
  "CreateAsyncClosureLongIndex#3": { 3: "function" },
  "CreateGenerator#3": { 3: "function" },
  "CreateGeneratorLongIndex#3": { 3: "function" },
  "CallDirect#3": { 3: "function" },
  "CallDirectLongIndex#3": { 3: "function" },
  // (dest, builtinNumber, argCount).
  "CallBuiltin#3": { 2: "builtin" },
  "CallBuiltinLong#3": { 2: "builtin" },
  // (dest, builtinNumber).
  "GetBuiltinClosure#2": { 2: "builtin" },
  // (dest, obj, cacheIndex, stringId[ids: string]) — pre- and post-v99 naming.
  "GetByIdShort#4": { 3: "cacheIndex" },
  "GetById#4": { 3: "cacheIndex" },
  "GetByIdLong#4": { 3: "cacheIndex" },
  "TryGetById#4": { 3: "cacheIndex" },
  "TryGetByIdLong#4": { 3: "cacheIndex" },
  "PutById#4": { 3: "cacheIndex" },
  "PutByIdLong#4": { 3: "cacheIndex" },
  "TryPutById#4": { 3: "cacheIndex" },
  "TryPutByIdLong#4": { 3: "cacheIndex" },
  "PutByIdLoose#4": { 3: "cacheIndex" },
  "PutByIdStrict#4": { 3: "cacheIndex" },
  "PutByIdLooseLong#4": { 3: "cacheIndex" },
  "PutByIdStrictLong#4": { 3: "cacheIndex" },
  "TryPutByIdLoose#4": { 3: "cacheIndex" },
  "TryPutByIdStrict#4": { 3: "cacheIndex" },
  "TryPutByIdLooseLong#4": { 3: "cacheIndex" },
  "TryPutByIdStrictLong#4": { 3: "cacheIndex" },
  "DefineOwnById#4": { 3: "cacheIndex" },
  "DefineOwnByIdLong#4": { 3: "cacheIndex" },
  // (dest, obj, cacheIndex, receiver, stringId[ids: string]).
  "GetByIdWithReceiverLong#5": { 3: "cacheIndex" },
};

function rolesForOpcode(op: OpcodeDef): readonly OperandRole[] {
  const override = ROLE_OVERRIDES[`${op.name}#${op.operands.length}`];
  return op.operands.map((type, i) => {
    const oneBased = i + 1;
    const fromOverride = override?.[oneBased];
    if (fromOverride !== undefined) return fromOverride;
    const idKind = op.ids?.[oneBased];
    if (idKind !== undefined) {
      const role = ID_KIND_TO_ROLE[idKind];
      if (role !== undefined) return role;
    }
    return DEFAULT_ROLE_BY_TYPE[type];
  });
}

const cache = new WeakMap<OpcodeTable, readonly (readonly OperandRole[])[]>();
let overridesVerified = false;

/** "A role override naming an opcode that does not exist in a table is an
 *  E_TABLE_ASSERT at load" (spec 02 §3.4) — checked once, lazily, across every
 *  generated table (not just the one first requested), so a stale override
 *  can't silently rot as tables are added. */
function verifyOverridesOnce(): void {
  if (overridesVerified) return;
  for (const key of Object.keys(ROLE_OVERRIDES)) {
    const hashIdx = key.lastIndexOf("#");
    const name = key.slice(0, hashIdx);
    const arity = Number(key.slice(hashIdx + 1));
    const existsSomewhere = listOpcodeTableIds().some((id) => getOpcodeTable(id).opcodes.some((op) => op.name === name && op.operands.length === arity));
    if (!existsSomewhere) {
      throw new Hbc2jsError(ErrorCode.E_TABLE_ASSERT, `roles.ts override ${JSON.stringify(key)} names an opcode/arity that does not exist in any generated table`, { section: "tables/roles" });
    }
  }
  overridesVerified = true;
}

/** Operand roles for every opcode in `table`, parallel to each `OpcodeDef.operands`
 *  array. Computed once per table and cached. */
export function operandRolesForTable(table: OpcodeTable): readonly (readonly OperandRole[])[] {
  verifyOverridesOnce();
  const cached = cache.get(table);
  if (cached !== undefined) return cached;
  const computed = table.opcodes.map(rolesForOpcode);
  cache.set(table, computed);
  return computed;
}

/** Operand roles for one opcode number in `table`. */
export function operandRoles(table: OpcodeTable, opcodeNumber: number): readonly OperandRole[] {
  const all = operandRolesForTable(table);
  const roles = all[opcodeNumber];
  if (roles === undefined) {
    throw new Hbc2jsError(ErrorCode.E_INTERNAL, `operandRoles: opcode ${opcodeNumber} out of range for table ${table.id}`, { section: "tables/roles" });
  }
  return roles;
}
