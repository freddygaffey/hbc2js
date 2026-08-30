// docs/specs/02-disassembler.md §2, §3 — instruction decoder.
import type { Diagnostic } from "../errors.ts";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { getOpcodeTable } from "../tables/registry.ts";
import { operandRolesForTable } from "../tables/roles.ts";
import type { OpcodeDef, OpcodeTable, OperandRole, OperandTypeName } from "../tables/types.ts";
export type { OperandRole } from "../tables/types.ts";
import type { ExceptionHandler, FunctionHeader, HbcModule } from "../parse/types.ts";
import { assignLabels } from "./labels.ts";
import { decodeStringSwitch, decodeUintSwitch } from "./switchtable.ts";
import type { SwitchTable } from "./switchtable.ts";
export type { SwitchCase, SwitchTable } from "./switchtable.ts";

export type OperandType = OperandTypeName;

export interface Operand {
  readonly type: OperandType;
  readonly role: OperandRole;
  /** Double values land here too (as a `number`); Imm32/Addr* are signed. */
  readonly value: number;
}

export type InstrKind = "normal" | "jump" | "condJump" | "switch" | "return" | "throw" | "catch" | "unreachable";

export interface Instruction {
  /** Function-relative offset of the opcode byte. */
  readonly offset: number;
  /** 1 + sum of operand widths. */
  readonly length: number;
  readonly opcode: number;
  readonly name: string;
  readonly operands: readonly Operand[];
  readonly kind: InstrKind;
  /** Function-relative targets. Empty for "normal"/"return"/"throw"/"catch"/
   *  "unreachable". One for "jump". One for "condJump" (the taken edge — the
   *  fallthrough is offset+length). default + cases, in that order, for "switch". */
  readonly targets: readonly number[];
  readonly fallsThrough: boolean;
  /** Present only for switch instructions. */
  readonly switchTable?: SwitchTable;
}

export interface DecodedFunction {
  readonly index: number;
  readonly header: FunctionHeader;
  readonly name: string;
  readonly instructions: readonly Instruction[];
  /** instruction offset -> index into `instructions`. */
  readonly byOffset: ReadonlyMap<number, number>;
  /** offset -> "L3". */
  readonly labels: ReadonlyMap<number, string>;
  readonly handlers: readonly ExceptionHandler[];
  readonly switchTables: readonly SwitchTable[];
  /** max(bytecodeSizeInBytes, end of the last jump table) — the function's true
   *  extent in the file. docs/HBC-FORMAT.md §12.8. */
  readonly extentEnd: number;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Kind classification (docs/specs/02-disassembler.md §3, HBC-FORMAT.md §11.1).
// Encoded as small name sets rather than a single opcode-name `if` chain: the
// `DEFINE_JUMP_{1,2,3}` macro family (HBC-FORMAT.md §11.1) produces every
// conditional-jump opcode plus `Jmp`/`JmpLong` *and* `SaveGenerator`/
// `SaveGeneratorLong` under the identical "exactly one Addr operand" shape, so
// the unconditional/generator-resume cases must be named explicitly — operand
// shape alone can't tell them apart from JmpTrue-style conditionals. Verified
// against third_party/hermes/hbc94/BytecodeList.def's DEFINE_JUMP_1/2/3 uses.
// ---------------------------------------------------------------------------
const UNCONDITIONAL_JUMP_NAMES = new Set(["Jmp", "JmpLong"]);
const RETURN_NAMES = new Set(["Ret"]);
// Only the bare, unconditional `Throw` has no fallthrough. `ThrowIfEmpty`,
// `ThrowIfUndefined`, `ThrowIfThisInitialized` throw only exceptionally (an
// exception-handler edge, not an operand target) and fall through normally —
// they correctly fall to the "normal" default below (no Addr operand).
const THROW_NAMES = new Set(["Throw"]);
const CATCH_NAMES = new Set(["Catch"]);
const UNREACHABLE_NAMES = new Set(["Unreachable"]);
const UINT_SWITCH_NAMES = new Set(["SwitchImm", "UIntSwitchImm"]);
const STRING_SWITCH_NAMES = new Set(["StringSwitchImm"]);

interface Classification {
  readonly kind: InstrKind;
  readonly switchKind: "uint" | "string" | undefined;
}

function classify(def: OpcodeDef): Classification {
  if (UINT_SWITCH_NAMES.has(def.name)) return { kind: "switch", switchKind: "uint" };
  if (STRING_SWITCH_NAMES.has(def.name)) return { kind: "switch", switchKind: "string" };
  if (UNREACHABLE_NAMES.has(def.name)) return { kind: "unreachable", switchKind: undefined };
  if (RETURN_NAMES.has(def.name)) return { kind: "return", switchKind: undefined };
  if (THROW_NAMES.has(def.name)) return { kind: "throw", switchKind: undefined };
  if (CATCH_NAMES.has(def.name)) return { kind: "catch", switchKind: undefined };
  if (UNCONDITIONAL_JUMP_NAMES.has(def.name)) return { kind: "jump", switchKind: undefined };
  const hasAddr = def.operands.some((t) => t === "Addr8" || t === "Addr32");
  if (hasAddr) return { kind: "condJump", switchKind: undefined };
  return { kind: "normal", switchKind: undefined };
}

function fallsThroughFor(kind: InstrKind): boolean {
  switch (kind) {
    case "jump":
    case "return":
    case "throw":
    case "unreachable":
    case "switch":
      return false;
    case "condJump":
    case "catch":
    case "normal":
      return true;
  }
}

// One DataView over the whole file, shared across every function decoded from
// the same module (docs/specs/02-disassembler.md §8 rule 3).
const viewCache = new WeakMap<Uint8Array, DataView>();
function fileView(bytes: Uint8Array): DataView {
  const cached = viewCache.get(bytes);
  if (cached !== undefined) return cached;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  viewCache.set(bytes, view);
  return view;
}

function readOperand(view: DataView, abs: number, type: OperandType): number {
  switch (type) {
    case "Reg8":
    case "UInt8":
      return view.getUint8(abs);
    case "UInt16":
      return view.getUint16(abs, true);
    case "Reg32":
    case "UInt32":
      return view.getUint32(abs, true);
    case "Addr8":
      return view.getInt8(abs);
    case "Addr32":
    case "Imm32":
      return view.getInt32(abs, true);
    case "Double":
      return view.getFloat64(abs, true);
  }
}

function validateIdOperand(mod: HbcModule, opName: string, op: Operand, functionIndex: number, insnOffset: number): void {
  const ctx = { functionIndex, offset: insnOffset, section: "disasm" };
  switch (op.role) {
    case "string":
      if (op.value < 0 || op.value >= mod.strings.count) {
        throw new Hbc2jsError(ErrorCode.E_BAD_STRING_ID, `${opName}: string id ${op.value} out of range [0, ${mod.strings.count})`, ctx);
      }
      return;
    case "function":
      if (op.value < 0 || op.value >= mod.functions.length) {
        throw new Hbc2jsError(ErrorCode.E_BAD_FUNCTION_ID, `${opName}: function id ${op.value} out of range [0, ${mod.functions.length})`, ctx);
      }
      return;
    case "bigint":
      if (op.value < 0 || op.value >= mod.bigInts.length) {
        throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `${opName}: bigint id ${op.value} out of range [0, ${mod.bigInts.length})`, ctx);
      }
      return;
    case "regexp":
      if (op.value < 0 || op.value >= mod.regExps.length) {
        throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `${opName}: regexp id ${op.value} out of range [0, ${mod.regExps.length})`, ctx);
      }
      return;
    case "shape":
      if (op.value < 0 || op.value >= mod.shapes.length) {
        throw new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, `${opName}: shape id ${op.value} out of range [0, ${mod.shapes.length})`, ctx);
      }
      return;
    default:
      return;
  }
}

function validateTargets(instructions: readonly Instruction[], size: number, byOffset: ReadonlyMap<number, number>, functionIndex: number): void {
  for (const insn of instructions) {
    for (const t of insn.targets) {
      if (t < 0 || t >= size) {
        throw new Hbc2jsError(ErrorCode.E_JUMP_OUT_OF_RANGE, `${insn.name} at offset ${insn.offset} targets ${t}, outside [0, ${size})`, {
          offset: insn.offset,
          functionIndex,
          section: "disasm",
        });
      }
      if (!byOffset.has(t)) {
        throw new Hbc2jsError(ErrorCode.E_JUMP_MISALIGNED, `${insn.name} at offset ${insn.offset} targets ${t}, which is not an instruction start`, {
          offset: insn.offset,
          functionIndex,
          section: "disasm",
        });
      }
    }
  }
}

function checkHandlerAlignment(handlers: readonly ExceptionHandler[], byOffset: ReadonlyMap<number, number>, size: number, functionIndex: number): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const [i, h] of handlers.entries()) {
    if (!byOffset.has(h.start)) {
      diags.push({ severity: "warn", code: "W_HANDLER_MISALIGNED", message: `handler ${i} start ${h.start} is not an instruction start`, context: { offset: h.start, functionIndex } });
    }
    if (h.end !== size && !byOffset.has(h.end)) {
      diags.push({ severity: "warn", code: "W_HANDLER_MISALIGNED", message: `handler ${i} end ${h.end} is not an instruction start (and != size ${size})`, context: { offset: h.end, functionIndex } });
    }
    if (!byOffset.has(h.target)) {
      diags.push({ severity: "warn", code: "W_HANDLER_MISALIGNED", message: `handler ${i} target ${h.target} is not an instruction start`, context: { offset: h.target, functionIndex } });
    }
  }
  return diags;
}

function requireOpcodeTable(mod: HbcModule): OpcodeTable {
  const id = mod.layout.opcodeTable;
  if (id === undefined) {
    throw new Hbc2jsError(ErrorCode.E_UNSUPPORTED_VERSION, `no opcode table generated for bytecode version ${mod.header.version} (layout ${mod.layout.layoutClass})`, {
      section: "disasm",
    });
  }
  return getOpcodeTable(id);
}

/** Probe-aware error hints, spec 02 §3.3 / review S1. `probe.sampledFunctions` is
 *  a *count*, not an index set (spec 01's `ProbeReport` — see this project's M2
 *  report for the follow-up needed to make this exact), so the best available
 *  approximation is: attach the hint whenever the probe was non-exhaustive at
 *  all, since we cannot tell from outside spec 01's layout probe which specific
 *  functions were in the sample. */
function attachProbeHint(mod: HbcModule, err: Hbc2jsError): Hbc2jsError {
  const probe = mod.layout.probe;
  if (probe.exhaustive || (err.code !== ErrorCode.E_UNKNOWN_OPCODE && err.code !== ErrorCode.E_OPERAND_OVERRUN)) return err;
  const n = probe.sampledFunctions ?? 0;
  const m = probe.totalFunctions ?? mod.functions.length;
  const hint = `the opcode table may be wrong: only ${n} of ${m} functions were probed; re-run with --verify for an exhaustive probe, or force one with --opcode-table=${mod.layout.opcodeTable ?? "<id>"}`;
  return new Hbc2jsError(err.code, err.message, { ...err.context, hint });
}

function decodeCore(mod: HbcModule, functionIndex: number, table: OpcodeTable): DecodedFunction {
  const fnRec = mod.functions[functionIndex];
  if (fnRec === undefined) {
    throw new Hbc2jsError(ErrorCode.E_BAD_FUNCTION_ID, `function index ${functionIndex} out of range [0, ${mod.functions.length})`, { functionIndex, section: "disasm" });
  }
  const header = fnRec.header;
  const size = header.bytecodeSizeInBytes;
  const view = fileView(mod.bytes);
  const roles = operandRolesForTable(table);

  const instructions: Instruction[] = [];
  const byOffset = new Map<number, number>();
  const switchTables: SwitchTable[] = [];
  let ip = 0;

  while (ip < size) {
    const opcodeAbs = header.offset + ip;
    const opcode = view.getUint8(opcodeAbs);
    const def = table.opcodes[opcode];
    if (def === undefined) {
      throw new Hbc2jsError(ErrorCode.E_UNKNOWN_OPCODE, `unknown opcode ${opcode} at function-relative offset ${ip}`, { offset: header.offset + ip, functionIndex, section: "disasm" });
    }
    // src/tables/types.ts's OpcodeDef.unverified: a table slot whose existence is
    // inferred but whose real name/operand signature has never been observed
    // (currently only hbc98-late's UnknownFastArrayOpcode98Late) must fail loudly
    // rather than guess a signature (D8/R1).
    if (def.unverified === true) {
      throw new Hbc2jsError(ErrorCode.E_UNKNOWN_OPCODE, `opcode ${opcode} (${def.name}) is an unverified placeholder in table ${table.id} — real signature unknown`, {
        offset: header.offset + ip,
        functionIndex,
        section: "disasm",
      });
    }
    const opRoles = roles[opcode]!;
    let o = ip + 1;
    const operands: Operand[] = [];
    for (let i = 0; i < def.operands.length; i++) {
      const type = def.operands[i]!;
      const info = table.operandTypes[type];
      const width = info.bytes;
      if (o + width > size) {
        throw new Hbc2jsError(ErrorCode.E_OPERAND_OVERRUN, `${def.name}: operand ${i + 1} (${type}) at offset ${ip} overruns bytecodeSizeInBytes=${size}`, {
          offset: header.offset + o,
          functionIndex,
          section: "disasm",
        });
      }
      const value = readOperand(view, header.offset + o, type);
      const operand: Operand = { type, role: opRoles[i]!, value };
      validateIdOperand(mod, def.name, operand, functionIndex, ip);
      operands.push(operand);
      o += width;
    }

    const { kind, switchKind } = classify(def);
    const length = o - ip;
    let targets: number[];
    let switchTable: SwitchTable | undefined;

    if (kind === "switch") {
      if (switchKind === "uint") {
        // (Reg8 value, UInt32 tableOffset, Addr32 defaultTarget, UInt32 min, UInt32 max)
        const tableOffset = operands[1]!.value;
        const defaultTargetRaw = operands[2]!.value;
        const min = operands[3]!.value;
        const max = operands[4]!.value;
        switchTable = decodeUintSwitch({
          bytes: mod.bytes,
          fileLength: mod.header.fileLength,
          functionOffset: header.offset,
          bytecodeSize: size,
          insnOffset: ip,
          functionIndex,
          tableOffset,
          defaultTarget: defaultTargetRaw,
          min,
          max,
        });
      } else {
        // (Reg8 value, UInt32 globalIndex, UInt32 tableOffset, Addr32 defaultTarget, UInt32 tableSize)
        const tableOffset = operands[2]!.value;
        const defaultTargetRaw = operands[3]!.value;
        const tableSize = operands[4]!.value;
        switchTable = decodeStringSwitch({
          bytes: mod.bytes,
          fileLength: mod.header.fileLength,
          functionOffset: header.offset,
          bytecodeSize: size,
          insnOffset: ip,
          functionIndex,
          tableOffset,
          defaultTarget: defaultTargetRaw,
          tableSize,
          stringCount: mod.strings.count,
        });
      }
      switchTables.push(switchTable);
      targets = [switchTable.defaultTarget, ...switchTable.cases.map((c) => c.target)];
    } else if (kind === "jump" || kind === "condJump") {
      const addrOperand = operands.find((op) => op.role === "addr");
      targets = addrOperand !== undefined ? [ip + addrOperand.value] : [];
    } else {
      targets = [];
    }

    instructions.push({
      offset: ip,
      length,
      opcode,
      name: def.name,
      operands,
      kind,
      targets,
      fallsThrough: fallsThroughFor(kind),
      ...(switchTable !== undefined ? { switchTable } : {}),
    });
    byOffset.set(ip, instructions.length - 1);
    ip = o;
  }

  if (ip !== size) {
    throw new Hbc2jsError(ErrorCode.E_OPERAND_OVERRUN, `trailing partial instruction: decode ended at ip=${ip} but bytecodeSizeInBytes=${size}`, {
      offset: header.offset + ip,
      functionIndex,
      section: "disasm",
    });
  }

  validateTargets(instructions, size, byOffset, functionIndex);
  const handlerDiagnostics = checkHandlerAlignment(fnRec.exceptionHandlers, byOffset, size, functionIndex);

  let extentEnd = size;
  for (const st of switchTables) extentEnd = Math.max(extentEnd, st.tableOffset + st.byteLength);

  const labels = assignLabels(instructions, fnRec.exceptionHandlers);

  return {
    index: functionIndex,
    header,
    name: fnRec.name,
    instructions,
    byOffset,
    labels,
    handlers: fnRec.exceptionHandlers,
    switchTables,
    extentEnd,
    diagnostics: handlerDiagnostics,
  };
}

export function decodeFunction(mod: HbcModule, functionIndex: number): DecodedFunction {
  const table = requireOpcodeTable(mod);
  try {
    return decodeCore(mod, functionIndex, table);
  } catch (e) {
    if (e instanceof Hbc2jsError) throw attachProbeHint(mod, e);
    throw e;
  }
}

export function tryDecodeFunction(mod: HbcModule, index: number, table: OpcodeTable): { ok: true; fn: DecodedFunction } | { ok: false; code: ErrorCode; offset: number } {
  try {
    return { ok: true, fn: decodeCore(mod, index, table) };
  } catch (e) {
    if (e instanceof Hbc2jsError) return { ok: false, code: e.code, offset: e.context.offset ?? -1 };
    throw e;
  }
}

export function* decodeModule(mod: HbcModule, opts?: { readonly indices?: readonly number[] }): Generator<DecodedFunction> {
  const indices = opts?.indices ?? Array.from({ length: mod.functions.length }, (_, i) => i);
  for (const i of indices) {
    yield decodeFunction(mod, i);
  }
}
