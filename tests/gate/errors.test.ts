import { test } from "node:test";
import assert from "node:assert/strict";
import { ErrorCode, Hbc2jsError, ParseError, DecodeError, assertInternal } from "../../src/errors.ts";

const EXPECTED_CODES = [
  "E_USAGE",
  "E_IO",
  "E_BAD_MAGIC",
  "E_TRUNCATED",
  "E_UNSUPPORTED_VERSION",
  "E_LAYOUT_AMBIGUOUS",
  "E_LAYOUT_NO_CANDIDATE",
  "E_SECTION_OVERRUN",
  "E_SECTION_MISMATCH",
  "E_BAD_STRING_ID",
  "E_BAD_FUNCTION_ID",
  "E_BAD_HANDLER",
  "E_BAD_LITERAL_TAG",
  "E_UNKNOWN_OPCODE",
  "E_OPERAND_OVERRUN",
  "E_JUMP_OUT_OF_RANGE",
  "E_JUMP_MISALIGNED",
  "E_SWITCH_TABLE",
  "E_TABLE_ASSERT",
  "E_INTERNAL",
];

// Added by M4 (specs 03 §7, 04 §7, 05 §10) and M5's framework (spec 07 §2.3),
// which spec 00 §6.1's list predates.
const M4_CODES = ["E_ENV_UNRESOLVED", "E_TOO_COMPLEX", "E_STRUCTURE_UNSOUND", "E_EMIT_UNSUPPORTED", "E_UNBOUND_IDENT", "E_PASS_ORDER", "E_PASS_CRASH"];

// Added by P2.1 (docs/specs/10-artifact-format.md §4.2): staleness is a hard
// error, never a wrong answer — there is no `--force`.
const P2_1_CODES = ["E_STALE_RANGES", "E_STALE_INDEX"];

test("ErrorCode exports every code from spec 00 section 6.1, plus the M4/M5 codes", () => {
  const actual = Object.values(ErrorCode).sort();
  assert.deepEqual(actual, [...EXPECTED_CODES, ...M4_CODES, ...P2_1_CODES].sort());
});

test("Hbc2jsError serialises code, message and context via toJSON", () => {
  const err = new Hbc2jsError(ErrorCode.E_BAD_MAGIC, "bad magic", { offset: 42, section: "header" });
  const json = err.toJSON();
  assert.equal(json.code, "E_BAD_MAGIC");
  assert.match(json.message, /bad magic/);
  assert.deepEqual(json.context, { offset: 42, section: "header" });
});

test("Hbc2jsError.message includes the offset and section when present", () => {
  const err = new Hbc2jsError(ErrorCode.E_SECTION_OVERRUN, "overrun", { offset: 0x10, section: "stringStorage" });
  assert.match(err.message, /0x10/);
  assert.match(err.message, /stringStorage/);
});

test("ParseError and DecodeError are Hbc2jsError subclasses with distinct names", () => {
  const p = new ParseError(ErrorCode.E_TRUNCATED, "x");
  const d = new DecodeError(ErrorCode.E_UNKNOWN_OPCODE, "y");
  assert.ok(p instanceof Hbc2jsError);
  assert.ok(d instanceof Hbc2jsError);
  assert.equal(p.name, "ParseError");
  assert.equal(d.name, "DecodeError");
});

test("assertInternal throws E_INTERNAL on a false condition and returns otherwise", () => {
  assert.doesNotThrow(() => assertInternal(true, "fine"));
  assert.throws(() => assertInternal(false, "broken"), (e: unknown) => e instanceof Hbc2jsError && (e as Hbc2jsError).code === ErrorCode.E_INTERNAL);
});
