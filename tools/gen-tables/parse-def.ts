// docs/specs/01-parser.md §5.4 — macro-aware parser for facebook/hermes'
// `BytecodeList.def` and `Builtins.def`. Pure functions, no filesystem access, so
// they are directly unit-testable (see tests/gate/tables/gen-tables.test.ts).
//
// Licence note (D4/R6): every rule here is derived by reading the *shape* of the
// vendored MIT `.def` files (third_party/hermes/**) — never hermes-dec.
import type { BuiltinDef, IdOperandKind, OpcodeDef, OperandTypeInfo, OperandTypeName } from "../../src/tables/types.ts";

/** docs/HBC-FORMAT.md §11.1 — the fixed, known operand-type set. A name outside
 *  this set, or a ctype that disagrees with it, is a hard error (§5.4 rule 2). */
const EXPECTED_OPERAND_TYPES: Readonly<Record<OperandTypeName, OperandTypeInfo>> = {
  Reg8: { bytes: 1, signed: false, kind: "reg" },
  Reg32: { bytes: 4, signed: false, kind: "reg" },
  UInt8: { bytes: 1, signed: false, kind: "uint" },
  UInt16: { bytes: 2, signed: false, kind: "uint" },
  UInt32: { bytes: 4, signed: false, kind: "uint" },
  Addr8: { bytes: 1, signed: true, kind: "addr" },
  Addr32: { bytes: 4, signed: true, kind: "addr" },
  Imm32: { bytes: 4, signed: true, kind: "int" },
  Double: { bytes: 8, signed: true, kind: "float" },
};

const CTYPE_MAP: Readonly<Record<string, { bytes: number; signed: boolean }>> = {
  uint8_t: { bytes: 1, signed: false },
  int8_t: { bytes: 1, signed: true },
  uint16_t: { bytes: 2, signed: false },
  int16_t: { bytes: 2, signed: true },
  uint32_t: { bytes: 4, signed: false },
  int32_t: { bytes: 4, signed: true },
  double: { bytes: 8, signed: true },
};

function isKnownOperandTypeName(name: string): name is OperandTypeName {
  return Object.prototype.hasOwnProperty.call(EXPECTED_OPERAND_TYPES, name);
}

/** Strip `//` and `/* *\/` comments, preserving line structure (block comments keep
 *  their embedded newlines so later line-based logic still sees the right lines). */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface RawInvocation {
  readonly macro: string;
  readonly args: readonly string[];
}

/** §5.4 rule 0: skip `#`-directive lines (including their backslash-continued
 *  bodies) and anything inside non-zero `#if`/`#ifdef`/`#ifndef` nesting depth —
 *  this alone implements the `HERMES_RUN_WASM` exclusion, no special case needed.
 *  What survives is scanned for `MACRO_NAME(args)` call sites, in file order. */
export function extractInvocations(text: string): readonly RawInvocation[] {
  const stripped = stripComments(text);
  const lines = stripped.split("\n");
  let depth = 0;
  let continuing = false;
  const keptLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (continuing) {
      continuing = trimmed.endsWith("\\");
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (/^#\s*(if|ifdef|ifndef)\b/.test(trimmed)) depth++;
      else if (/^#\s*endif\b/.test(trimmed)) depth = Math.max(0, depth - 1);
      // #else / #elif / #define / #undef / #include / #error: depth unchanged here.
      continuing = trimmed.endsWith("\\");
      continue;
    }
    if (depth > 0) continue;
    if (trimmed === "") continue;
    keptLines.push(line);
  }

  const kept = keptLines.join("\n");
  const invocations: RawInvocation[] = [];
  // Macro names here are always ALL_CAPS_WITH_UNDERSCORES_AND_DIGITS; argument
  // lists never nest parens in this file, so a non-nesting capture is exact.
  const re = /\b([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(kept)) !== null) {
    const macro = m[1]!;
    const argsRaw = m[2]!;
    const args = argsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    invocations.push({ macro, args });
  }
  return invocations;
}

function assertValidOpcodeName(name: string, macro: string): void {
  if (name === "name" || name === "name##Long" || name.includes("#") || name.includes("...")) {
    throw new Error(
      `parse-def: invocation of ${macro} produced placeholder-shaped opcode name ${JSON.stringify(name)} — ` +
        `the macro-body/preamble skipping logic let a definition leak through as an invocation`,
    );
  }
}

export interface ParsedBytecodeList {
  readonly operandTypes: Readonly<Record<OperandTypeName, OperandTypeInfo>>;
  readonly opcodes: readonly OpcodeDef[];
  /** §5.4 rule 9 — an independently derived total, to be asserted equal to
   *  opcodes.length by the caller. */
  readonly independentCount: number;
}

const OPCODE_MACRO_RE = /^DEFINE_OPCODE_([0-6])$/;
const JUMP_MACRO_RE = /^DEFINE_JUMP_([0-9]+)$/;
const NOOP_MACROS = new Set([
  "DEFINE_RET_TARGET",
  "ASSERT_EQUAL_LAYOUT1",
  "ASSERT_EQUAL_LAYOUT2",
  "ASSERT_EQUAL_LAYOUT3",
  "ASSERT_EQUAL_LAYOUT4",
  "ASSERT_MONOTONE_INCREASING",
  "DEFINE_JUMP_LONG_VARIANT",
  "DEFINE_OPCODE", // bare fallback body target; never a real rule-3 invocation
  "DEFINE_VALUE_BUFFER_USER", // v99+: literal-buffer delta-mode bookkeeping, not an opcode
]);

export function parseBytecodeListDef(text: string): ParsedBytecodeList {
  const invocations = extractInvocations(text);
  const operandTypes: Partial<Record<OperandTypeName, OperandTypeInfo>> = {};
  const opcodes: OpcodeDef[] = [];
  const idOperandsByName = new Map<string, Record<number, IdOperandKind>>();
  let opcodeInvocations = 0;
  let jumpInvocations = 0;
  let n = 0;

  const pushOpcode = (name: string, operands: readonly OperandTypeName[]): void => {
    assertValidOpcodeName(name, "opcode");
    opcodes.push({ n: n++, name, operands });
  };

  for (const { macro, args } of invocations) {
    if (macro === "DEFINE_OPERAND_TYPE") {
      const [name, ctype] = args;
      if (name === undefined || ctype === undefined) {
        throw new Error(`parse-def: DEFINE_OPERAND_TYPE needs 2 args, got ${JSON.stringify(args)}`);
      }
      if (!isKnownOperandTypeName(name)) {
        throw new Error(`parse-def: unknown operand type name ${JSON.stringify(name)} — HBC-FORMAT.md §11.1 must be updated first`);
      }
      const derived = CTYPE_MAP[ctype];
      if (derived === undefined) {
        throw new Error(`parse-def: unknown C type ${JSON.stringify(ctype)} for operand ${name}`);
      }
      const expected = EXPECTED_OPERAND_TYPES[name];
      if (derived.bytes !== expected.bytes || derived.signed !== expected.signed) {
        throw new Error(
          `parse-def: operand type ${name} derived from ctype ${ctype} as ${JSON.stringify(derived)} ` +
            `disagrees with docs/HBC-FORMAT.md §11.1 (${JSON.stringify(expected)})`,
        );
      }
      operandTypes[name] = expected;
      continue;
    }

    const opcodeMatch = OPCODE_MACRO_RE.exec(macro);
    if (opcodeMatch !== null) {
      const arity = Number(opcodeMatch[1]);
      const name = args[0];
      if (name === undefined) throw new Error(`parse-def: ${macro} invoked with no name`);
      const operandNames = args.slice(1);
      if (operandNames.length !== arity) {
        throw new Error(`parse-def: ${macro}(${args.join(", ")}) declares ${operandNames.length} operands, expected ${arity}`);
      }
      const operands = operandNames.map((o) => {
        if (!isKnownOperandTypeName(o)) {
          throw new Error(`parse-def: opcode ${name} uses unknown operand type ${JSON.stringify(o)}`);
        }
        return o;
      });
      pushOpcode(name, operands);
      opcodeInvocations++;
      continue;
    }

    const jumpMatch = JUMP_MACRO_RE.exec(macro);
    if (jumpMatch !== null) {
      const arity = Number(jumpMatch[1]);
      const name = args[0];
      if (name === undefined || args.length !== 1) {
        throw new Error(`parse-def: ${macro} expects exactly one arg (the base name), got ${JSON.stringify(args)}`);
      }
      const regTail: OperandTypeName[] = Array.from({ length: arity - 1 }, () => "Reg8");
      pushOpcode(name, ["Addr8", ...regTail]);
      pushOpcode(`${name}Long`, ["Addr32", ...regTail]);
      jumpInvocations++;
      continue;
    }

    if (macro === "OPERAND_STRING_ID" || macro === "OPERAND_BIGINT_ID" || macro === "OPERAND_FUNCTION_ID") {
      const [name, idxStr] = args;
      if (name === undefined || idxStr === undefined) {
        throw new Error(`parse-def: ${macro} needs 2 args, got ${JSON.stringify(args)}`);
      }
      const idx = Number(idxStr);
      if (!Number.isInteger(idx) || idx < 1) {
        throw new Error(`parse-def: ${macro}(${name}, ${idxStr}) has a non-positive-integer operand index`);
      }
      const kind: IdOperandKind = macro === "OPERAND_STRING_ID" ? "string" : macro === "OPERAND_BIGINT_ID" ? "bigint" : "function";
      const entry = idOperandsByName.get(name) ?? {};
      entry[idx] = kind;
      idOperandsByName.set(name, entry);
      continue;
    }

    if (NOOP_MACROS.has(macro)) continue;

    throw new Error(
      `parse-def: unmodelled macro ${macro}(${args.join(", ")}) in BytecodeList.def — ` +
        `§5.4 requires failing loudly rather than silently ignoring an unknown macro shape`,
    );
  }

  // Attach captured id-operand annotations to their opcodes.
  const withIds = opcodes.map((op) => {
    const ids = idOperandsByName.get(op.name);
    return ids !== undefined ? { ...op, ids: { ...ids } } : op;
  });

  for (const name of ["Reg8", "Reg32", "UInt8", "UInt16", "UInt32", "Addr8", "Addr32", "Imm32", "Double"] as const) {
    if (operandTypes[name] === undefined) {
      throw new Error(`parse-def: DEFINE_OPERAND_TYPE never defined ${name}`);
    }
  }

  return {
    operandTypes: operandTypes as Record<OperandTypeName, OperandTypeInfo>,
    opcodes: withIds,
    independentCount: opcodeInvocations + 2 * jumpInvocations,
  };
}

const BUILTIN_COUNTING_MACROS = new Set(["NORMAL_METHOD", "BUILTIN_METHOD", "PRIVATE_BUILTIN", "JS_BUILTIN"]);
const BUILTIN_NOOP_MACROS = new Set(["NORMAL_OBJECT", "BUILTIN_OBJECT", "MARK_FIRST_PRIVATE_BUILTIN", "MARK_FIRST_JS_BUILTIN"]);

/** §5.4 — builtin numbers are positional across NORMAL_METHOD / BUILTIN_METHOD /
 *  PRIVATE_BUILTIN / JS_BUILTIN invocations, in file order. `*_OBJECT` and
 *  `MARK_FIRST_*` invocations are grouping/bookkeeping only and consume no number. */
export function parseBuiltinsDef(text: string): readonly BuiltinDef[] {
  const invocations = extractInvocations(text);
  const builtins: BuiltinDef[] = [];
  let n = 0;

  for (const { macro, args } of invocations) {
    if (macro === "NORMAL_METHOD" || macro === "BUILTIN_METHOD") {
      const [object, method] = args;
      if (object === undefined || method === undefined) {
        throw new Error(`parse-def: ${macro} needs 2 args, got ${JSON.stringify(args)}`);
      }
      builtins.push({ n: n++, name: `${object}.${method}`, object, method });
      continue;
    }
    if (macro === "PRIVATE_BUILTIN" || macro === "JS_BUILTIN") {
      const [name] = args;
      if (name === undefined) throw new Error(`parse-def: ${macro} needs 1 arg, got ${JSON.stringify(args)}`);
      builtins.push({ n: n++, name });
      continue;
    }
    if (BUILTIN_NOOP_MACROS.has(macro)) continue;
    if (BUILTIN_COUNTING_MACROS.has(macro)) continue; // unreachable, kept for clarity

    throw new Error(`parse-def: unmodelled macro ${macro}(${args.join(", ")}) in Builtins.def`);
  }

  return builtins;
}
