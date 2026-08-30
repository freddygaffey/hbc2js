// docs/specs/05-emitter.md §4 — conditional-jump opcode -> JS expression.
//
// A **table** keyed by opcode name, not a `switch` statement, so an unhandled
// conditional is a loud E_EMIT_UNSUPPORTED naming the opcode rather than a
// silently wrong branch.
//
// Numeric fast-path forms (`JLessN`, `JGreaterEqualN`, …) assert their operands
// are numbers; that is a VM optimisation, not observable behaviour, so they
// lower to the same operator as the general form.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Instruction } from "../disasm/decode.ts";
import type { BinaryOp, Expr } from "./ast.ts";
import { bin, un } from "./ast.ts";

type CondBuilder = (operands: readonly Expr[], insn: Instruction) => Expr;

const cmp =
  (op: BinaryOp, negate = false): CondBuilder =>
  (o): Expr => {
    const e = bin(op, o[0]!, o[1]!);
    return negate ? un("!", e) : e;
  };

/**
 * Register operands of a conditional jump, in source order, skipping the address.
 * Every `DEFINE_JUMP_*` opcode is `(Addr, …)`.
 */
export function condRegisters(insn: Instruction): number[] {
  return insn.operands.filter((o) => o.role === "reg").map((o) => o.value);
}

const TABLE: Readonly<Record<string, CondBuilder>> = {
  JmpTrue: (o) => o[0]!,
  JmpFalse: (o) => un("!", o[0]!),
  JmpUndefined: (o) => bin("===", o[0]!, { k: "lit", text: "undefined" }),

  JLess: cmp("<"),
  JLessN: cmp("<"),
  JLessEqual: cmp("<="),
  JLessEqualN: cmp("<="),
  JGreater: cmp(">"),
  JGreaterN: cmp(">"),
  JGreaterEqual: cmp(">="),
  JGreaterEqualN: cmp(">="),
  JNotLess: cmp("<", true),
  JNotLessN: cmp("<", true),
  JNotLessEqual: cmp("<=", true),
  JNotLessEqualN: cmp("<=", true),
  JNotGreater: cmp(">", true),
  JNotGreaterN: cmp(">", true),
  JNotGreaterEqual: cmp(">=", true),
  JNotGreaterEqualN: cmp(">=", true),

  JEqual: cmp("=="),
  JNotEqual: cmp("!="),
  JStrictEqual: cmp("==="),
  JStrictNotEqual: cmp("!=="),
};

/** All `Long` variants share their short form's semantics. */
function baseName(name: string): string {
  return name.endsWith("Long") ? name.slice(0, -"Long".length) : name;
}

export function isConditionalJump(name: string): boolean {
  return Object.hasOwn(TABLE, baseName(name)) || baseName(name) === "JmpBuiltinIs" || baseName(name) === "JmpBuiltinIsNot" || baseName(name) === "JmpTypeOfIs";
}

/**
 * The JS expression that is true exactly when `insn`'s *taken* edge is taken.
 * `regs` supplies the already-lowered register expressions, in operand order.
 */
export function conditionFor(insn: Instruction, regs: readonly Expr[], extra: { readonly builtin?: Expr; readonly typeOfIsMask?: number }, functionIndex: number): Expr {
  const name = baseName(insn.name);
  const builder = TABLE[name];
  if (builder !== undefined) return builder(regs, insn);

  if (name === "JmpBuiltinIs" || name === "JmpBuiltinIsNot") {
    if (extra.builtin === undefined) {
      throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `${insn.name}: builtin operand could not be resolved`, { functionIndex, offset: insn.offset, section: "emit/conds" });
    }
    const e = bin("===", regs[0]!, extra.builtin);
    return name === "JmpBuiltinIs" ? e : un("!", e);
  }

  if (name === "JmpTypeOfIs") {
    const mask = extra.typeOfIsMask ?? -1;
    // Only the Function bit is confirmed against real bytecode (every
    // `JmpTypeOfIs` in the corpus is mask 128, guarding
    // `throwTypeError("Trying to call a non-function")`). `TypeOfIsTypes` is not
    // in the vendored headers, so any other mask is refused rather than guessed
    // (D8: never guess on ambiguity).
    if (mask === 128) return bin("===", un("typeof ", regs[0]!), { k: "lit", text: '"function"' });
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `JmpTypeOfIs mask ${mask} is not in the verified TypeOfIsTypes set (only 128 = Function is confirmed)`, {
      functionIndex,
      offset: insn.offset,
      section: "emit/conds",
    });
  }

  throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `no conditional lowering for ${insn.name}`, { functionIndex, offset: insn.offset, section: "emit/conds" });
}
