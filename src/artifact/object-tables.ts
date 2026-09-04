// src/artifact/object-tables.ts — the bytecode half of the `object-tables`
// verb (docs/specs/10-artifact-format.md §3.1, docs/specs/17-mcp-harness.md
// §14.2): a bundle-wide inventory of CONSTANT object literals, so a hunt can
// ask "show me every endpoint table" in one shot instead of grepping for a
// key it already guessed (the Service NSW hunt found a second complete
// endpoint table, `LicenceAPIEndpoints`, only by luck —
// docs/specs/hunt-tooling-backlog.md, "Round 2 tool-gaps").
//
// No JS parsing and no decompilation: every object literal whose members are
// compile-time constants is a `NewObjectWithBuffer` / `…Long` /
// `NewObjectWithBufferAndParent` whose keys and values live in the key/value
// buffers, so one pass over the DISASSEMBLY of every function (decode only —
// no CFG, no frames) is the whole scan. Operand shapes follow
// `src/emit/lower.ts`'s own `NewObjectWithBuffer` case: v≤96 carries
// `(dest, sizeHint, numProps, keyBufferIdx, valueBufferIdx)` inline, v≥97
// carries `(dest, shapeTableIdx, valueBufferOffset)` with the keys behind
// `mod.shapes`.
//
// Best-effort extra: members whose value is COMPUTED (`BASE + "/x"`, a
// template literal) are not in the buffer at all — hermesc emits them as
// `PutNewOwnById`/`PutById` on the literal's own register right after it.
// Those keys are recovered by a short straight-line walk forward from the
// literal, stopping at the first branch target, the first non-`normal`
// instruction, or the first instruction that redefines the register. Keys
// only; the value is reported as `<computed>` because proving it would need
// the decompiler.
import { decodeFunction, type DecodedFunction, type Instruction } from "../disasm/decode.ts";
import { objectBufferValues, objectKeysTolerant } from "../emit/literals.ts";
import type { HbcModule } from "../parse/types.ts";

/** Longest string value reported for one member; longer values are cut and
 *  suffixed with `…` (the inventory is a map, not a string dump — use
 *  `query string` for the full value). */
export const MAX_VALUE_CHARS = 200;

const WITH_BUFFER = new Set(["NewObjectWithBuffer", "NewObjectWithBufferLong", "NewObjectWithBufferAndParent"]);
const PUT_NEW_OWN = /^(PutNewOwnById|DefineOwnById)(Long|Short)?$/;
const PUT_BY_ID = /^(Try)?PutById(Loose|Strict)?(Long)?$/;
/** v≥98 lowers "overwrite member k of the shape I just built" as
 *  `PutOwnBySlotIdx dst, value, slot` — no string operand at all, the key is
 *  `keys[slot]` (the shape's own buffer order). Measured on
 *  `39-destructuring-params` v98/v99, where v84–96 emit `PutNewOwnByIdShort`
 *  for the same source. */
const PUT_BY_SLOT = /^PutOwnBySlotIdx(Long)?$/;
/** Instruction families whose operand 0 is a SOURCE register (an object being
 *  written to, an environment) rather than a destination — everything else
 *  with a register operand 0 is treated as redefining it, which ends the
 *  computed-member walk. */
const NOT_A_DEF = /^(Put|Store|Define|Ret|Throw)/;

/** What kind of value a member holds. `computed` is the best-effort
 *  `PutNewOwnById` tail (value unknown by construction). */
export type ObjectTableValueKind = "string" | "number" | "boolean" | "null" | "undefined" | "computed" | "unknown";

export interface ObjectTableMember {
  readonly key: string;
  /** The constant string value, truncated to `MAX_VALUE_CHARS`; `null` for
   *  every non-string kind (including `computed`). */
  readonly value: string | null;
  readonly kind: ObjectTableValueKind;
}

/** One constant object literal found in the bundle. `numProps` counts the
 *  BUFFER members only; `members` also carries the computed tail, so
 *  `members.length ≥ numProps`. */
export interface ObjectTableRow {
  readonly fn: number;
  /** Function-relative offset of the `NewObjectWithBuffer*` instruction. */
  readonly offset: number;
  readonly module: number | null;
  readonly numProps: number;
  readonly members: readonly ObjectTableMember[];
  /** Buffer members whose value is a constant string. */
  readonly strings: number;
  /** Buffer members whose value is a constant non-string. */
  readonly nonStrings: number;
  /** Members recovered from the `PutNewOwnById`/`PutById` tail. */
  readonly computed: number;
}

export interface ObjectTableScan {
  readonly rows: readonly ObjectTableRow[];
  /** How many functions the scan decoded (the denominator for "found N in M
   *  functions"). */
  readonly scanned: number;
  /** Functions whose bytecode would not decode — skipped, never fatal (an
   *  inventory of the rest is still worth having). */
  readonly failed: number;
}

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

function truncate(s: string): string {
  return s.length <= MAX_VALUE_CHARS ? s : `${s.slice(0, MAX_VALUE_CHARS)}…`;
}

/** Keys put on `dst` by the straight-line instructions after `from`, i.e. the
 *  members whose values hermesc could not put in the buffer. Stops at the
 *  first branch target (`decoded.labels`), the first non-`normal` instruction
 *  and the first redefinition of `dst` — never crosses a CFG edge, so a
 *  reported key is always really this literal's. */
function computedTail(mod: HbcModule, decoded: DecodedFunction, from: number, dst: number, keys: readonly string[]): string[] {
  const tailKeys: string[] = [];
  for (let i = from + 1; i < decoded.instructions.length; i++) {
    const insn = decoded.instructions[i]!;
    if (decoded.labels.has(insn.offset)) break;
    if (insn.kind !== "normal") break;
    const name = insn.name;
    const isPutNewOwn = PUT_NEW_OWN.test(name);
    const isPutById = PUT_BY_ID.test(name);
    if (PUT_BY_SLOT.test(name) && insn.operands[0]?.role === "reg" && V(insn, 0) === dst) {
      const key = keys[V(insn, 2)];
      if (key !== undefined) tailKeys.push(key);
      continue;
    }
    if ((isPutNewOwn || isPutById) && insn.operands[0]?.role === "reg" && V(insn, 0) === dst) {
      // PutById's string operand is index 3; PutNewOwnById*/DefineOwnById*
      // carry it last (src/emit/lower.ts's own two cases).
      const sid = isPutById ? V(insn, 3) : V(insn, insn.operands.length - 1);
      try {
        tailKeys.push(mod.strings.get(sid));
      } catch {
        /* out-of-range string id: skip this member, keep scanning */
      }
      continue;
    }
    if (insn.operands[0]?.role === "reg" && V(insn, 0) === dst && !NOT_A_DEF.test(name)) break;
  }
  return tailKeys;
}

/** Decode the whole module once and return every constant object literal in
 *  it. O(instructions); the caller (`ArtifactService.objectTables`) memoises
 *  this so repeated filtered queries are free. */
export function scanObjectTables(mod: HbcModule, moduleOf: (fn: number) => number | null): ObjectTableScan {
  const rows: ObjectTableRow[] = [];
  let scanned = 0;
  let failed = 0;
  for (let fnIndex = 0; fnIndex < mod.functions.length; fnIndex++) {
    let decoded: DecodedFunction;
    try {
      decoded = decodeFunction(mod, fnIndex);
    } catch {
      failed++;
      continue;
    }
    scanned++;
    for (let i = 0; i < decoded.instructions.length; i++) {
      const insn = decoded.instructions[i]!;
      if (!WITH_BUFFER.has(insn.name)) continue;

      let keyBufferOffset: number;
      let numProps: number;
      let valueOffset: number;
      if (insn.name === "NewObjectWithBufferAndParent") {
        const shape = mod.shapes[V(insn, 2)];
        if (shape === undefined) continue;
        keyBufferOffset = shape.keyBufferOffset;
        numProps = shape.numProps;
        valueOffset = V(insn, 3);
      } else if (insn.operands.length === 5) {
        // v≤96: (dest, sizeHint, numProps, keyBufferIdx, valueBufferIdx)
        keyBufferOffset = V(insn, 3);
        numProps = V(insn, 2);
        valueOffset = V(insn, 4);
      } else {
        // v≥97: (dest, shapeTableIdx, valueBufferOffset)
        const shape = mod.shapes[V(insn, 1)];
        if (shape === undefined) continue;
        keyBufferOffset = shape.keyBufferOffset;
        numProps = shape.numProps;
        valueOffset = V(insn, 2);
      }

      const keys = objectKeysTolerant(mod, keyBufferOffset, numProps);
      if (keys === null) continue; // undecodable key buffer: skip, never throw
      const values = objectBufferValues(mod, valueOffset, keys.length);

      const members: ObjectTableMember[] = [];
      let strings = 0;
      let nonStrings = 0;
      for (let k = 0; k < keys.length; k++) {
        const v = values[k] ?? null;
        if (v === null) {
          members.push({ key: keys[k]!, value: null, kind: "unknown" });
          nonStrings++;
          continue;
        }
        if (v.kind === "string") {
          let text: string;
          try {
            text = mod.strings.get(v.stringId);
          } catch {
            members.push({ key: keys[k]!, value: null, kind: "unknown" });
            nonStrings++;
            continue;
          }
          members.push({ key: keys[k]!, value: truncate(text), kind: "string" });
          strings++;
          continue;
        }
        const kind: ObjectTableValueKind = v.kind === "integer" ? "number" : v.kind;
        members.push({ key: keys[k]!, value: null, kind });
        nonStrings++;
      }

      // A computed member usually has a PLACEHOLDER in the buffer (hermesc
      // emits `{a: null}` then `PutNewOwnById a`), so a tail key that already
      // exists replaces that placeholder rather than duplicating it — the
      // final value of that member really is computed.
      const tail = computedTail(mod, decoded, i, V(insn, 0), keys);
      let computed = 0;
      for (const key of tail) {
        const at = members.findIndex((m) => m.key === key);
        if (at >= 0) {
          if (members[at]!.kind === "string") strings--;
          else nonStrings--;
          members[at] = { key, value: null, kind: "computed" };
        } else {
          members.push({ key, value: null, kind: "computed" });
        }
        computed++;
      }

      rows.push({
        fn: decoded.index,
        offset: insn.offset,
        module: moduleOf(decoded.index),
        numProps: keys.length,
        members,
        strings,
        nonStrings,
        computed,
      });
    }
  }
  return { rows, scanned, failed };
}
