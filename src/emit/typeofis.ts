// docs/specs/05-emitter.md §8 (loud failure) — `TypeOfIs` / `JmpTypeOfIs`'s mask operand.
//
// The operand is a `TypeOfIsTypes` bitset from
// `include/hermes/FrontEndDefs/Typeof.h` (vendored per pin, hashed in
// `third_party/hermes/<id>/VENDOR.yml`, bit order generated into
// `src/tables/generated/typeofis-<id>.ts`). Bit `i` is the `i`-th name in the
// header's `HERMES_TYPEOF_IS_TYPES` macro list; there is no negate flag, so a
// `!==` test compiles to the complement mask (mask 507 = everything but
// `String` = `typeof x !== "string"`).
//
// Review M4-H2: before this, only bit 7 (`Function`, mask 128) was confirmed
// and every other mask was `E_EMIT_UNSUPPORTED` — which is what stopped the
// Discord and Shopify bundles. A table id whose Hermes commit predates the
// opcode still has no table, and a mask there is still refused.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { HbcModule } from "../parse/types.ts";
import { getTypeOfIsTable } from "../tables/registry.ts";
import type { TypeOfIsTable } from "../tables/types.ts";
import type { Expr } from "./ast.ts";
import { bin, lit, un } from "./ast.ts";

/** One `typeof`-category test. The header's own note: "Object" does not match
 *  `null` or functions, and `Null` is its own bit. */
function testFor(type: string, value: Expr): Expr {
  switch (type) {
    case "Undefined":
      return bin("===", un("typeof ", value), lit('"undefined"'));
    case "Object":
      return { k: "logical", op: "&&", left: bin("===", un("typeof ", value), lit('"object"')), right: bin("!==", value, lit("null")) };
    case "String":
      return bin("===", un("typeof ", value), lit('"string"'));
    case "Symbol":
      return bin("===", un("typeof ", value), lit('"symbol"'));
    case "Boolean":
      return bin("===", un("typeof ", value), lit('"boolean"'));
    case "Number":
      return bin("===", un("typeof ", value), lit('"number"'));
    case "Bigint":
      return bin("===", un("typeof ", value), lit('"bigint"'));
    case "Function":
      return bin("===", un("typeof ", value), lit('"function"'));
    case "Null":
      return bin("===", value, lit("null"));
    default:
      throw new Error(`typeofis: unknown TypeOfIsTypes member ${JSON.stringify(type)} — Typeof.h gained a type and this lowering must be extended`);
  }
}

function disjunction(types: readonly string[], value: Expr): Expr {
  let out: Expr | undefined;
  for (const t of types) {
    const test = testFor(t, value);
    out = out === undefined ? test : { k: "logical", op: "||", left: out, right: test };
  }
  // A mask of 0 matches nothing; a full mask matches everything. Both are legal
  // bitsets, so they get a constant rather than an error.
  return out ?? lit("false");
}

/**
 * `mask` -> a JS predicate on `value`.
 *
 * `value` is evaluated more than once (an `Object` bit needs a null check, and
 * a multi-bit mask needs one test per bit), so callers must pass a *pure*
 * expression — every call site passes a register read.
 *
 * The nine members are exhaustive over JS values (`typeof`'s eight results,
 * with `object` split into `Object` and `Null`), so a mask with more than half
 * its bits set is emitted as the negation of its complement — which is what
 * turns the 51 MB bundles' mask 507 back into the `typeof x !== "string"` the
 * programmer wrote.
 */
export function typeOfIsExpr(value: Expr, mask: number, table: TypeOfIsTable | null, where: { opcode: string; functionIndex: number; offset: number; section: string }): Expr {
  if (table === null) {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `${where.opcode} mask ${mask}: this opcode table's Hermes pin has no Typeof.h, so the TypeOfIsTypes bit order is unknown here`, {
      functionIndex: where.functionIndex,
      offset: where.offset,
      section: where.section,
    });
  }
  const width = table.types.length;
  if (!Number.isInteger(mask) || mask < 0 || mask >= 1 << width) {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `${where.opcode} mask ${mask} is out of range for a ${width}-bit TypeOfIsTypes (${table.types.join(", ")})`, {
      functionIndex: where.functionIndex,
      offset: where.offset,
      section: where.section,
    });
  }
  const set: string[] = [];
  const unset: string[] = [];
  for (let i = 0; i < width; i++) {
    (mask & (1 << i) ? set : unset).push(table.types[i]!);
  }
  if (unset.length === 0) return lit("true");
  if (set.length === 0) return lit("false");
  return set.length * 2 > width ? un("!", disjunction(unset, value)) : disjunction(set, value);
}

/** The module's own opcode table's `TypeOfIsTypes` order, or `null` when the
 *  table was never resolved or its pin predates the opcode. */
export function typeOfIsTableFor(mod: HbcModule): TypeOfIsTable | null {
  const id = mod.layout.opcodeTable;
  return id === undefined ? null : getTypeOfIsTable(id);
}
