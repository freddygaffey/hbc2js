// src/artifact/template-injections.ts — the bytecode half of the
// `template-injections` verb (docs/specs/17-mcp-harness.md §14.3,
// docs/specs/hunt-tooling-backlog.md line ~55, hunt lead C1): a bundle-wide
// scan for the WebView-injection anti-pattern — a string built at runtime by
// splicing an unproven value INSIDE a quoted JS string, e.g.
// `` `window.foo('${userValue}')` `` or `"x = '" + userValue + "'"`. That
// shape is exactly the thing that turns "we pass a value into
// `injectedJavaScript`" into "we pass a value into `injectedJavaScript` in a
// position an attacker can break out of with a `'` in the value".
//
// No decompilation: like `object-tables.ts`, this decodes every function
// ONCE (decode only — no CFG, no frames) and walks it straight-line,
// tracking a per-register "reaching definition" map that is DROPPED at every
// branch target (`decoded.labels`) — so a reported chunk is always really
// this call's, never guessed across a CFG edge. Two bytecode shapes are
// recognised, matching `docs/lowering/template-literals.md`'s finding that
// hermesc never confuses them (`concat` is ToString per piece, `+` is
// ToPrimitive):
//
//  - `kind: "template"` — an untagged template literal, which lowers to ONE
//    call whose callee resolves (through the SAME straight-line register
//    map) to a `Get*ById "concat"` off a `Get*ById "HermesInternal"` base,
//    `this` = the first cooked chunk, and args alternate
//    `substitution, chunk, substitution, …` (`docs/lowering/
//    template-literals.md` §2). Both the explicit-register call opcodes
//    (`Call1`..`Call4`) and the generic `Call`/`CallLong` (args recovered via
//    the same `argBase - i` frame convention `src/emit/lower.ts`'s
//    `frameArgs` uses, computed here from the function header alone — no
//    CFG needed) are handled.
//  - `kind: "concat"` — ordinary `+`, which never emits a `concat` call
//    (verified at every version/opt-level in the lowering doc above): a
//    chain of `Add`/`AddN`/`AddS` whose leaves are literal strings and
//    holes. Only the OUTERMOST `Add` of a chain is flattened (recursing
//    through operands whose reaching def is itself an `Add`), so
//    `'a' + b + 'c'`'s two `Add` instructions are read as the one chain
//    `["a", <hole>, "c"]`, not reported twice.
//
// **What is NOT recognised (truth rule — no heuristics that guess):**
//  - A `Reflect.apply` indirection around the concat callee (the emitter's
//    OWN rebuild of the raw call, `docs/lowering/template-literals.md` §3 —
//    this scanner reads the RAW bytecode, which is a direct `Call*`).
//  - A callee reached through more than one register hop across a BRANCH
//    (the reaching-def map is dropped at every label — deliberately: a
//    definition that depends on which edge was taken is not "this call's"
//    with certainty).
//  - A template/concat chain where any chunk position is not a compile-time
//    string literal (e.g. a nested template) — the whole call is skipped,
//    never reported with a guessed chunk.
//  - String concatenation via `.concat(...)` on anything OTHER than
//    `HermesInternal` (plain `Array.prototype.concat`/`String.prototype.
//    concat` calls are extremely common and are not templates).
//  - A quote pair whose static text is split across TWO SEPARATE literal
//    values that never appear in the same call/chain (each row's prefix and
//    suffix come only from that one call/chain's own chunks).
import { decodeFunction, type DecodedFunction, type Instruction } from "../disasm/decode.ts";
import { argSlotBase } from "../emit/semantics.ts";
import type { HbcModule } from "../parse/types.ts";
import { drainSync, type Steps } from "../incremental.ts";

/** Longest prefix/suffix text reported per row; longer text is cut from the
 *  QUOTE end (the end nearest the hole) and suffixed/prefixed with `…` — the
 *  hole itself is always kept, only distant context is trimmed. */
export const MAX_CONTEXT_CHARS = 120;

/** A single-codepoint marker for "a substitution goes here", chosen because
 *  U+0000 cannot appear in a Hermes string-table entry read through
 *  `mod.strings.get` (JS strings can contain it in principle; in practice a
 *  NUL byte inside a bundle's own string CONSTANTS is not a shape this
 *  scanner needs to special-case — see the file header). */
const HOLE = "\u0000";

const CALL_EXPLICIT = new Set(["Call1", "Call2", "Call3", "Call4"]);
const CALL_GENERIC = new Set(["Call", "CallLong"]);
const GET_BY_ID = /^(TryGetById|GetById)(Short|Long)?$/;
const ADD = new Set(["Add", "AddN", "AddS"]);
const LOAD_CONST_STRING = /^LoadConstString(LongIndex)?$/;
/** A register-allocator spill/copy: propagate whatever the source register's
 *  reaching def is (or clear the destination if the source has none), so a
 *  chunk/callee resolved through a `Mov` is not lost. */
const MOV = /^Mov(Long)?$/;
/** Same family `object-tables.ts` uses: instruction names whose operand 0 is
 *  a SOURCE register rather than a destination. */
const NOT_A_DEF = /^(Put|Store|Define|Ret|Throw)/;

/** Max pieces (literal chunks + holes) flattened out of one call/chain
 *  before giving up — a circuit-breaker against a pathological register
 *  chain, not a real-world limit (a template with this many substitutions
 *  has never been observed). */
const MAX_PIECES = 64;

export type TemplateInjectionKind = "template" | "concat";

export interface TemplateInjectionRow {
  readonly fn: number;
  /** Function-relative offset of the call (`template`) or the outermost
   *  `Add`/`AddN`/`AddS` (`concat`) instruction. */
  readonly offset: number;
  readonly module: number | null;
  readonly kind: TemplateInjectionKind;
  readonly quote: "'" | '"';
  /** Static text immediately BEFORE the opening quote, capped at
   *  `MAX_CONTEXT_CHARS` (cut from the far end, keeping the text nearest the
   *  quote). */
  readonly prefix: string;
  /** Static text immediately AFTER the closing quote, capped the same way. */
  readonly suffix: string;
  /** How many of this call/chain's substitutions fall INSIDE the reported
   *  quote pair — the ranking key. */
  readonly substitutions: number;
  /** Total substitutions in the whole template/chain (≥ `substitutions`). */
  readonly nSubs: number;
}

export interface TemplateInjectionScan {
  readonly rows: readonly TemplateInjectionRow[];
  readonly scanned: number;
  readonly failed: number;
}

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

// ---------------------------------------------------------------------------
// Reaching-definition tracking (straight-line only, dropped at every label).
// ---------------------------------------------------------------------------

type RegDef =
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "prop"; readonly prop: string; readonly base: RegDef | undefined }
  | { readonly kind: "add"; readonly lhs: RegDef | undefined; readonly rhs: RegDef | undefined }
  | { readonly kind: "other" };

type Piece = { readonly text: string } | { readonly hole: true };

function isLiteralPiece(p: Piece): p is { readonly text: string } {
  return "text" in p;
}

/** Flatten a reaching def into literal-string / hole pieces, recursing only
 *  through `add` nodes (an `Add` chain) — a `prop`/`other` def, or a missing
 *  one (parameter, or a register never seen because it was last defined
 *  before a branch), is one hole. Bails (returns `null`) past `MAX_PIECES`. */
function flatten(def: RegDef | undefined, out: Piece[]): boolean {
  if (out.length > MAX_PIECES) return false;
  if (def === undefined) {
    out.push({ hole: true });
    return true;
  }
  switch (def.kind) {
    case "string":
      out.push({ text: def.text });
      return true;
    case "add":
      return flatten(def.lhs, out) && flatten(def.rhs, out);
    default:
      out.push({ hole: true });
      return true;
  }
}

/** From a flattened piece list, find the quote pair (if any) that encloses
 *  the MOST holes, and build the row fields. `null` when no quote pair
 *  encloses a hole at all — the common case, never reported. */
function findInjection(pieces: readonly Piece[]): { quote: "'" | '"'; prefix: string; suffix: string; substitutions: number } | null {
  const nSubs = pieces.filter((p) => !isLiteralPiece(p)).length;
  if (nSubs === 0) return null;
  let flat = "";
  for (const p of pieces) flat += isLiteralPiece(p) ? p.text : HOLE;

  let best: { quote: "'" | '"'; start: number; end: number; substitutions: number } | null = null;
  for (const quote of ["'", '"'] as const) {
    let from = 0;
    for (;;) {
      const start = flat.indexOf(quote, from);
      if (start < 0) break;
      const end = flat.indexOf(quote, start + 1);
      if (end < 0) break;
      const inner = flat.slice(start + 1, end);
      const substitutions = inner.split(HOLE).length - 1;
      if (substitutions > 0 && (best === null || substitutions > best.substitutions)) {
        best = { quote, start, end, substitutions };
      }
      from = start + 1; // overlapping starts allowed; closing quotes are not
    }
  }
  if (best === null) return null;

  const rawPrefix = flat.slice(0, best.start);
  const rawSuffix = flat.slice(best.end + 1);
  const toText = (s: string): string => s.split(HOLE).join("${…}");
  const prefixText = toText(rawPrefix);
  const suffixText = toText(rawSuffix);
  return {
    quote: best.quote,
    prefix: prefixText.length <= MAX_CONTEXT_CHARS ? prefixText : `…${prefixText.slice(prefixText.length - MAX_CONTEXT_CHARS)}`,
    suffix: suffixText.length <= MAX_CONTEXT_CHARS ? suffixText : `${suffixText.slice(0, MAX_CONTEXT_CHARS)}…`,
    substitutions: best.substitutions,
  };
}

/** Registers this call reads as `(this, ...args)`, `this` first — the same
 *  order `docs/lowering/template-literals.md` §2 describes for a concat
 *  call. `null` for a call shape this scanner does not decode (out-of-range
 *  generic arg count). */
function callArgRegisters(insn: Instruction, header: DecodedFunction["header"], version: number): number[] | null {
  if (CALL_EXPLICIT.has(insn.name)) {
    const regs: number[] = [];
    for (let i = 2; i < insn.operands.length; i++) regs.push(V(insn, i));
    return regs;
  }
  if (CALL_GENERIC.has(insn.name)) {
    const argCount = V(insn, 2);
    if (argCount <= 0 || argCount > 200) return null;
    const base = argSlotBase(version, header.frameSize);
    const regs: number[] = [];
    for (let i = 0; i < argCount; i++) regs.push(base - i);
    return regs;
  }
  return null;
}

/** One function's contribution to the scan. Exported for the unit test. */
export function scanFunction(mod: HbcModule, decoded: DecodedFunction, moduleOf: (fn: number) => number | null): TemplateInjectionRow[] {
  const rows: TemplateInjectionRow[] = [];
  let defs = new Map<number, RegDef>();

  for (const insn of decoded.instructions) {
    if (decoded.labels.has(insn.offset)) defs = new Map();

    // --- kind: "template" --------------------------------------------------
    const callArgs = callArgRegisters(insn, decoded.header, mod.header.version);
    if (callArgs !== null && callArgs.length >= 3 && callArgs.length % 2 === 1) {
      const calleeReg = V(insn, 1);
      const callee = defs.get(calleeReg);
      const base = callee?.kind === "prop" ? callee.base : undefined;
      if (callee?.kind === "prop" && callee.prop === "concat" && base?.kind === "prop" && base.prop === "HermesInternal") {
        const pieces: Piece[] = [];
        let ok = true;
        for (let i = 0; i < callArgs.length && ok; i += 2) {
          // Chunks sit at even indices (this=0, C1=2, C2=4, ...); every
          // chunk MUST resolve to a string literal or the whole call is
          // skipped (never a guessed chunk — file header, "what is NOT
          // recognised").
          const def = defs.get(callArgs[i]!);
          if (def?.kind !== "string") {
            ok = false;
            break;
          }
          pieces.push({ text: def.text });
          if (i + 1 < callArgs.length) pieces.push({ hole: true });
        }
        if (ok && pieces.length <= MAX_PIECES) {
          const found = findInjection(pieces);
          if (found !== null) {
            rows.push({
              fn: decoded.index,
              offset: insn.offset,
              module: moduleOf(decoded.index),
              kind: "template",
              quote: found.quote,
              prefix: found.prefix,
              suffix: found.suffix,
              substitutions: found.substitutions,
              nSubs: pieces.filter((p) => !isLiteralPiece(p)).length,
            });
          }
        }
      }
    }

    // --- kind: "concat" (`+` chain) -----------------------------------------
    if (ADD.has(insn.name)) {
      const lhsDef = defs.get(V(insn, 1));
      const rhsDef = defs.get(V(insn, 2));
      // Only an OUTERMOST Add is worth flattening: an Add whose own result
      // is about to be folded into a LATER Add is an intermediate link, and
      // the later Add's flatten already walks through it (recursion in
      // `flatten`). We cannot look ahead, so we flatten every Add site; an
      // inner site simply cannot match on its own (its hole has no closing
      // chunk yet), which the loop below shows is harmless, not wrong.
      const pieces: Piece[] = [];
      if (flatten({ kind: "add", lhs: lhsDef, rhs: rhsDef }, pieces) && pieces.some(isLiteralPiece) && pieces.some((p) => !isLiteralPiece(p))) {
        const found = findInjection(pieces);
        if (found !== null) {
          rows.push({
            fn: decoded.index,
            offset: insn.offset,
            module: moduleOf(decoded.index),
            kind: "concat",
            quote: found.quote,
            prefix: found.prefix,
            suffix: found.suffix,
            substitutions: found.substitutions,
            nSubs: pieces.filter((p) => !isLiteralPiece(p)).length,
          });
        }
      }
    }

    // --- reaching-def update -------------------------------------------------
    const dstOperand = insn.operands[0];
    if (dstOperand === undefined || dstOperand.role !== "reg" || NOT_A_DEF.test(insn.name)) continue;
    const dst = V(insn, 0);
    if (LOAD_CONST_STRING.test(insn.name)) {
      let text: string;
      try {
        text = mod.strings.get(V(insn, 1));
      } catch {
        defs.delete(dst);
        continue;
      }
      defs.set(dst, { kind: "string", text });
    } else if (GET_BY_ID.test(insn.name)) {
      let prop: string;
      try {
        prop = mod.strings.get(V(insn, insn.operands.length - 1));
      } catch {
        defs.delete(dst);
        continue;
      }
      defs.set(dst, { kind: "prop", prop, base: defs.get(V(insn, 1)) });
    } else if (ADD.has(insn.name)) {
      defs.set(dst, { kind: "add", lhs: defs.get(V(insn, 1)), rhs: defs.get(V(insn, 2)) });
    } else if (MOV.test(insn.name)) {
      const src = defs.get(V(insn, 1));
      if (src === undefined) defs.delete(dst);
      else defs.set(dst, src);
    } else {
      defs.delete(dst);
    }
  }
  return rows;
}

/** Decode the whole module once and return every template/concat injection
 *  site in it. O(instructions); the caller (`ArtifactService
 *  .templateInjections`) memoises this so repeated filtered queries are
 *  free. */
export function scanTemplateInjections(mod: HbcModule, moduleOf: (fn: number) => number | null): TemplateInjectionScan {
  return drainSync(scanTemplateInjectionsSteps(mod, moduleOf));
}

/** The same scan as {@link scanTemplateInjections}, expressed as steps (one
 *  `yield` per function) so a caller on a shared event loop can drain it
 *  without freezing every other request for the whole pass — it decodes
 *  EVERY function in the bundle, 23 s on a real 12 MB app
 *  (`src/incremental.ts`, docs/BUGS.md "template-injections blocks the
 *  ui-server" row). `scanTemplateInjections` is this generator drained
 *  straight through, so the two can never disagree. */
export function* scanTemplateInjectionsSteps(mod: HbcModule, moduleOf: (fn: number) => number | null): Steps<TemplateInjectionScan> {
  const rows: TemplateInjectionRow[] = [];
  let scanned = 0;
  let failed = 0;
  for (let fnIndex = 0; fnIndex < mod.functions.length; fnIndex++) {
    yield;
    let decoded: DecodedFunction;
    try {
      decoded = decodeFunction(mod, fnIndex);
    } catch {
      failed++;
      continue;
    }
    scanned++;
    rows.push(...scanFunction(mod, decoded, moduleOf));
  }
  return { rows, scanned, failed };
}

/** Sort comparator: most substitutions inside quotes first, then by `fn` —
 *  `docs/specs/17-mcp-harness.md` §14.3. Exported for the unit test. */
export function compareTemplateInjections(a: TemplateInjectionRow, b: TemplateInjectionRow): number {
  if (a.substitutions !== b.substitutions) return b.substitutions - a.substitutions;
  return a.fn - b.fn;
}
