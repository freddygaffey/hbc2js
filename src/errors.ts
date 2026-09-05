// docs/specs/00-project-skeleton.md §6.1

export const ErrorCode = {
  // usage / IO
  E_USAGE: "E_USAGE",
  E_IO: "E_IO",
  // container-level
  E_BAD_MAGIC: "E_BAD_MAGIC",
  E_TRUNCATED: "E_TRUNCATED",
  E_UNSUPPORTED_VERSION: "E_UNSUPPORTED_VERSION",
  E_LAYOUT_AMBIGUOUS: "E_LAYOUT_AMBIGUOUS",
  E_LAYOUT_NO_CANDIDATE: "E_LAYOUT_NO_CANDIDATE",
  // structural
  E_SECTION_OVERRUN: "E_SECTION_OVERRUN",
  E_SECTION_MISMATCH: "E_SECTION_MISMATCH",
  E_BAD_STRING_ID: "E_BAD_STRING_ID",
  E_BAD_FUNCTION_ID: "E_BAD_FUNCTION_ID",
  E_BAD_HANDLER: "E_BAD_HANDLER",
  E_BAD_LITERAL_TAG: "E_BAD_LITERAL_TAG",
  // decode
  E_UNKNOWN_OPCODE: "E_UNKNOWN_OPCODE",
  E_OPERAND_OVERRUN: "E_OPERAND_OVERRUN",
  E_JUMP_OUT_OF_RANGE: "E_JUMP_OUT_OF_RANGE",
  E_JUMP_MISALIGNED: "E_JUMP_MISALIGNED",
  E_SWITCH_TABLE: "E_SWITCH_TABLE",
  // tables
  E_TABLE_ASSERT: "E_TABLE_ASSERT",
  // cfg / structurer / emitter (M4 — docs/specs/03-cfg.md §7, 04 §7, 05 §10)
  E_ENV_UNRESOLVED: "E_ENV_UNRESOLVED",
  E_TOO_COMPLEX: "E_TOO_COMPLEX",
  E_STRUCTURE_UNSOUND: "E_STRUCTURE_UNSOUND",
  E_EMIT_UNSUPPORTED: "E_EMIT_UNSUPPORTED",
  E_UNBOUND_IDENT: "E_UNBOUND_IDENT",
  // pass ladder (docs/specs/07-pass-ladder.md §2.3)
  E_PASS_ORDER: "E_PASS_ORDER",
  E_PASS_CRASH: "E_PASS_CRASH",
  // artifact / query (docs/specs/10-artifact-format.md §4.2) — staleness is a
  // hard error, never a wrong answer; there is no --force.
  E_STALE_RANGES: "E_STALE_RANGES",
  E_STALE_INDEX: "E_STALE_INDEX",
  // project store (docs/specs/11-project-store.md §2.5, §7 step 5): a store
  // whose builtFor doesn't match the loaded artifact is refused at open —
  // step 6 relaxes this into live orphan-flagging instead of a hard refusal.
  E_STALE_PROJECT_STORE: "E_STALE_PROJECT_STORE",
  // internal
  E_INTERNAL: "E_INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorContext {
  readonly offset?: number; // absolute file offset
  readonly section?: string; // e.g. "smallStringTable"
  readonly functionIndex?: number;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string; // one sentence, actionable
  // W_PASS_REFUSED (docs/specs/passes/25-yield-async-recovery.md §5): the
  // pass that refused, its named reason code, and how many distinct sites.
  readonly pass?: string;
  readonly reason?: string;
  readonly count?: number;
}

function formatMessage(code: ErrorCode, message: string, context: ErrorContext): string {
  let out = `${code}: ${message}`;
  if (context.offset !== undefined) {
    out += ` (at 0x${context.offset.toString(16)}${context.section ? ` in ${context.section}` : ""})`;
  } else if (context.section !== undefined) {
    out += ` (in ${context.section})`;
  }
  return out;
}

export class Hbc2jsError extends Error {
  readonly code: ErrorCode;
  readonly context: ErrorContext;
  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(formatMessage(code, message, context));
    this.name = "Hbc2jsError";
    this.code = code;
    this.context = context;
  }

  /** Deterministic serialisation of code/message/context, for tests and --json. */
  toJSON(): { code: ErrorCode; message: string; context: ErrorContext } {
    return { code: this.code, message: this.message, context: this.context };
  }
}

export class ParseError extends Hbc2jsError {
  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(code, message, context);
    this.name = "ParseError";
  }
}

export class DecodeError extends Hbc2jsError {
  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(code, message, context);
    this.name = "DecodeError";
  }
}

export type Severity = "warn" | "info";

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: string; // "W_..." namespace, distinct from ErrorCode
  readonly message: string;
  readonly context: ErrorContext;
}

/** Throws E_INTERNAL. For invariants that only our own code can break. */
export function assertInternal(cond: unknown, msg: string, context: ErrorContext = {}): asserts cond {
  if (!cond) {
    throw new Hbc2jsError(ErrorCode.E_INTERNAL, msg, context);
  }
}
