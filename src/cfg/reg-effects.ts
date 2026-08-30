// Which register operands an instruction *writes*. Shared by the environment
// tracker (docs/specs/03-cfg.md §6.2) and by the object-shape tracker the
// emitter needs for PutOwnBySlotIdx.
//
// The default is "operand 0, when it has role `reg`". Two explicit tables carry
// the exceptions, both derived from the vendored BytecodeList.def doc comments
// in third_party/hermes/*/BytecodeList.def:
//   * READ_ONLY_OP0 — stores and terminators whose first operand is a source.
//   * EXTRA_DESTS   — opcodes documented "Arg<n> [in/out]" or with two outputs.
import type { Instruction } from "../disasm/decode.ts";

const READ_ONLY_OP0: ReadonlySet<string> = new Set([
  // terminators / effects
  "Ret",
  "Throw",
  "ThrowIfThisInitialized",
  "IteratorClose",
  "SwitchImm",
  "UIntSwitchImm",
  "StringSwitchImm",
  "CacheNewObject",
  // property stores (Arg1 is the object)
  "PutById",
  "PutByIdLong",
  "PutByIdLoose",
  "PutByIdLooseLong",
  "PutByIdStrict",
  "PutByIdStrictLong",
  "TryPutById",
  "TryPutByIdLong",
  "TryPutByIdLoose",
  "TryPutByIdLooseLong",
  "TryPutByIdStrict",
  "TryPutByIdStrictLong",
  "PutByVal",
  "PutByValLoose",
  "PutByValStrict",
  "PutByValWithReceiver",
  "PutNewOwnById",
  "PutNewOwnByIdLong",
  "PutNewOwnByIdShort",
  "PutNewOwnNEById",
  "PutNewOwnNEByIdLong",
  "PutOwnByIndex",
  "PutOwnByIndexL",
  "PutOwnBySlotIdx",
  "PutOwnBySlotIdxLong",
  "PutOwnByVal",
  "PutOwnGetterSetterByVal",
  "PutOwnPrivateBySym",
  "AddOwnPrivateBySym",
  "DefineOwnById",
  "DefineOwnByIdLong",
  "DefineOwnByIndex",
  "DefineOwnByIndexL",
  "DefineOwnByVal",
  "DefineOwnGetterSetterByVal",
  "DefineOwnInDenseArray",
  "DefineOwnInDenseArrayL",
  // environment stores (Arg1 is the environment)
  "StoreToEnvironment",
  "StoreToEnvironmentL",
  "StoreNPToEnvironment",
  "StoreNPToEnvironmentL",
  // fast arrays / typed objects
  "FastArrayAppend",
  "FastArrayPush",
  "FastArrayStore",
  "TypedStoreParent",
]);

/** Additional written operand indices, beyond operand 0. */
const EXTRA_DESTS: Readonly<Record<string, readonly number[]>> = {
  // "Arg2 [in/out] is the source. Output for either the source or next method."
  IteratorBegin: [1],
  // "Arg2 [in/out] is the iterator or index."
  IteratorNext: [1],
  // Arg3/Arg4 are the iterating index and the size, both written.
  GetPNameList: [2, 3],
  GetNextPName: [3, 4],
  // "Arg2 is the output register for the home object."
  CreateBaseClass: [1],
  CreateBaseClassLongIndex: [1],
  CreateDerivedClass: [1],
  CreateDerivedClassLongIndex: [1],
  // the lazily-materialised `arguments` register
  GetArgumentsLength: [1],
  GetArgumentsPropByVal: [2],
  GetArgumentsPropByValLoose: [2],
  GetArgumentsPropByValStrict: [2],
};

/** Register numbers written by `insn`. */
export function writtenRegisters(insn: Instruction): number[] {
  const out: number[] = [];
  const op0 = insn.operands[0];
  if (op0 !== undefined && op0.role === "reg" && !READ_ONLY_OP0.has(insn.name)) out.push(op0.value);
  for (const i of EXTRA_DESTS[insn.name] ?? []) {
    const op = insn.operands[i];
    if (op !== undefined && op.role === "reg" && !out.includes(op.value)) out.push(op.value);
  }
  return out;
}

/** True when operand 0 is the (single) destination register. */
export function hasDestOperand0(insn: Instruction): boolean {
  const op0 = insn.operands[0];
  return op0 !== undefined && op0.role === "reg" && !READ_ONLY_OP0.has(insn.name);
}
