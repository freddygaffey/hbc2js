// src/deps/sig-normalise.ts — signature-tier normaliser for package
// recognition (D17/D17a).
//
// Promoted from `tools/pkgsig/lib/sig-normalise.mjs`. Deliberately a *fork*
// of `src/harness/roundtrip.ts`'s `normaliseFunction`, not a shared helper:
// D3 requires that oracle to stay byte-exact for round-trip diffing, while
// this one additionally masks a Metro require-call-site dependency-map
// index (docs/PACKAGE-SIGNATURES.md §3.2/§5.1) — a build-graph-position-
// dependent integer that would otherwise depress exact-hash match rates for
// any function containing an internal `require()`.
//
// Every Metro-compiled CommonJS factory function receives
// `(global, require, importDefault, importAll, module, exports,
// dependencyMap)`-shaped parameters with the dependency map always last
// (Babel drops unused trailing params, never reorders). A
// `require(d[N])`/`_dependencyMap[N]` call site therefore always compiles to
// one of two shapes:
//   (a) LoadConst{Zero,UInt8,Int,Double} %i, N ; GetByVal %v, %depmap, %i
//   (b) GetByIndex %v, %depmap, N              (hbc98+, immediate index)
// Both bake N as a plain `imm`-role operand; this file masks it to a
// canonical `dep#` token for both instruction shapes.

import { getBuiltinTable } from "../tables/registry.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction, Instruction, Operand } from "../disasm/decode.ts";

function builtinName(mod: HbcModule, n: number): string {
  const id = mod.layout.builtinTable;
  if (id === undefined) return "?";
  const table = getBuiltinTable(id);
  return table.builtins.find((b) => b.n === n)?.name ?? "?";
}

function maskedFunctionName(name: string): string {
  return name === "global" ? "global" : "~";
}

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);

// `hermesc -g` (debug info on) inserts `AsyncBreakCheck` at every function
// entry and loop back-edge, and `Debugger` for `debugger;` statements —
// neither carries any semantics the signature cares about, and the former
// shifts every offset so that not a single function of a `-g` build hashes
// like its release twin (docs/reviews/deps-v1.md). Both are elided from the
// exact, fuzzy and instruction-count views so release and debug builds of
// the same source fingerprint identically (D17d).
const DEBUG_ONLY_INSTRUCTIONS = new Set(["AsyncBreakCheck", "Debugger"]);

export function isDebugOnlyInstruction(name: string): boolean {
  return DEBUG_ONLY_INSTRUCTIONS.has(name);
}

/** The instructions a signature is computed over: `fn.instructions` minus
 *  debug-only ones. Labels that sat on an elided instruction are carried to
 *  the next kept one (a loop back-edge targets the `AsyncBreakCheck` in a
 *  `-g` build and the loop head itself in a release build — same label
 *  either way once elided). */
export function signatureInstructions(fn: DecodedFunction): { readonly insn: Instruction; readonly labels: readonly string[] }[] {
  const out: { insn: Instruction; labels: string[] }[] = [];
  let pending: string[] = [];
  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    if (label !== undefined) pending.push(label);
    if (isDebugOnlyInstruction(insn.name)) continue;
    out.push({ insn, labels: pending });
    pending = [];
  }
  return out;
}

type MaskMode = "self" | "load";
type RegState = { readonly kind: "depmap" } | { readonly kind: "constimm"; readonly offset: number } | undefined;

/**
 * Local dataflow pass (flat, single forward scan — Metro's require-call-site
 * idiom is always straight-line, no intervening branch between the
 * `LoadParam`/`LoadConst` and the `GetByVal`/`GetByIndex` that consumes it)
 * recovering the set of instruction offsets whose `imm` operand is a
 * dependency-map index and should be masked. Returns a
 * `Map<offset, "self" | "load">`: "self" masks that instruction's own imm
 * operand (`GetByIndex`'s immediate form); "load" masks the *earlier*
 * `LoadConst` instruction at that offset (the `GetByVal` + separate
 * index-register form).
 */
function findDependencyIndexOperands(fn: DecodedFunction): Map<number, MaskMode> {
  const lastParamIndex = fn.header.paramCount - 1;
  const masked = new Map<number, MaskMode>();
  const regState = new Map<number, RegState>();

  for (const insn of fn.instructions) {
    const ops = insn.operands;

    if (insn.name === "LoadParam" && ops.length >= 2 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, ops[1]!.value === lastParamIndex ? { kind: "depmap" } : undefined);
      continue;
    }
    if (LOAD_CONST_NUMERIC.has(insn.name) && ops.length >= 1 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, { kind: "constimm", offset: insn.offset });
      continue;
    }
    if (insn.name === "GetByVal" && ops.length === 3 && ops[0]!.role === "reg" && ops[1]!.role === "reg" && ops[2]!.role === "reg") {
      const base = regState.get(ops[1]!.value);
      const idx = regState.get(ops[2]!.value);
      if (base?.kind === "depmap" && idx?.kind === "constimm") {
        masked.set(idx.offset, "load");
      }
      regState.set(ops[0]!.value, undefined);
      continue;
    }
    if (insn.name === "GetByIndex" && ops.length === 3 && ops[0]!.role === "reg" && ops[1]!.role === "reg" && ops[2]!.role === "imm") {
      const base = regState.get(ops[1]!.value);
      if (base?.kind === "depmap") {
        masked.set(insn.offset, "self");
      }
      regState.set(ops[0]!.value, undefined);
      continue;
    }
    if (ops.length > 0 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, undefined);
    }
  }
  return masked;
}

function operandToken(mod: HbcModule, op: Operand, insn: Instruction, fn: DecodedFunction, regName: (n: number) => string, maskedImm: boolean): string {
  switch (op.role) {
    case "reg":
      return regName(op.value);
    case "addr": {
      const target = insn.targets[0];
      const label = target !== undefined ? fn.labels.get(target) : undefined;
      return label ?? "@?";
    }
    case "string":
      return `s#"${mod.strings.get(op.value)}"`;
    case "function":
      return `f#"${maskedFunctionName(mod.functions[op.value]?.name ?? "?")}"`;
    case "bigint": {
      const entry = mod.bigInts[op.value];
      return `bi#${entry !== undefined ? entry.value().toString() : "?"}n`;
    }
    case "regexp":
      return "re#";
    case "builtin":
      return `b#"${builtinName(mod, op.value)}"`;
    case "cacheIndex":
      return "#";
    case "shape": {
      const shape = mod.shapes[op.value];
      return `sh#(numProps=${shape !== undefined ? shape.numProps : "?"})`;
    }
    case "literalOffset":
      return "lit#";
    case "double":
    case "imm":
    case "envSlot":
      if (maskedImm) return "dep#";
      return String(op.value);
    default:
      return String(op.value);
  }
}

function normaliseSwitch(mod: HbcModule, insn: Instruction, fn: DecodedFunction): string {
  const st = insn.switchTable;
  if (st === undefined) return "";
  const defaultLabel = fn.labels.get(st.defaultTarget) ?? "@?";
  const cases = st.cases
    .map((c) => {
      const label = fn.labels.get(c.target) ?? "@?";
      const value = st.kind === "string" ? `s#"${mod.strings.get(c.value)}"` : String(c.value);
      return `${value}->${label}`;
    })
    .join(" ");
  return `.switch ${insn.name} default=${defaultLabel} ${cases}`;
}

/** `%N` in first-use order (the exact tier — permutation-invariant, but still
 *  sensitive to a *different register-reuse pattern* between two builds,
 *  since the same canonical name persists for a physical register's whole
 *  lifetime: see `regMaskedFunctionSignature` below). */
function firstUseRegNamer(): (n: number) => string {
  const regs = new Map<number, string>();
  return (n: number): string => {
    let r = regs.get(n);
    if (r === undefined) {
      r = `%${regs.size}`;
      regs.set(n, r);
    }
    return r;
  };
}

/** Every register operand collapses to the same opaque token, regardless of
 *  number or reuse pattern (the register-insensitive tier below). */
function maskedRegNamer(): (n: number) => string {
  return () => "%_";
}

function buildNormalisedLines(mod: HbcModule, fn: DecodedFunction, regName: (n: number) => string): string[] {
  const maskedOffsets = findDependencyIndexOperands(fn);
  const lines = [`fn(${fn.header.paramCount}) ${maskedFunctionName(fn.name)}`];

  for (const { insn, labels } of signatureInstructions(fn)) {
    const prefix = labels.map((l) => `${l}: `).join("");
    if (insn.kind === "switch") {
      lines.push(prefix + normaliseSwitch(mod, insn, fn));
      continue;
    }
    const maskMode = maskedOffsets.get(insn.offset);
    const ops = insn.operands
      .filter((o) => o.role !== "cacheIndex")
      .map((op, idx) => {
        const isMasked = maskMode === "self" ? idx === insn.operands.length - 1 && op.role === "imm" : maskMode === "load" && op.role !== "reg";
        return operandToken(mod, op, insn, fn, regName, isMasked);
      });
    lines.push(`${prefix}${insn.name} ${ops.join(", ")}`.trimEnd());
  }

  for (const h of fn.handlers) {
    const start = fn.labels.get(h.start) ?? "@?";
    const end = fn.labels.get(h.end) ?? "@?";
    const target = fn.labels.get(h.target) ?? "@?";
    lines.push(`.try ${start}..${end} -> ${target}`);
  }

  return lines;
}

/**
 * Signature-tier drop-in replacement for `normaliseFunction`: byte-identical
 * output for every function that does *not* contain a require()-call-site
 * dependency-map index, and masks the dependency-index immediate for the
 * ones that do. Registers are renamed `%N` in first-use order, which makes
 * this exact tier invariant to a pure register-number *permutation* between
 * two builds but not to a different register-*reuse* pattern (a physical
 * register recycled for a second, unrelated live range at a different point
 * than the other build recycles a — possibly different — register): see
 * `regMaskedFunctionSignature`, the D17h-c register-insensitive tier, for
 * that case.
 */
export function normaliseFunctionForSignature(mod: HbcModule, fn: DecodedFunction): string {
  return buildNormalisedLines(mod, fn, firstUseRegNamer()).join("\n");
}

/**
 * Register-insensitive signature tier (D17h-c, `docs/DEPS.md` "Confidence
 * tiers"). Same as `normaliseFunctionForSignature` except every register
 * operand collapses to one opaque token instead of being renamed by
 * first-use order — so, unlike the exact tier, this is invariant not just to
 * a register-number permutation but to *any* difference in the allocator's
 * register-reuse pattern (which register-allocation optimisation levels and
 * hermesc revisions are both free to vary, `hermesc -g`'s extra
 * `AsyncBreakCheck`/`Debugger` insertions among them — docs/DEPS.md §6.7).
 * Strictly weaker than the exact tier at telling two *different* register
 * operands of the *same* instruction apart (`Add %_, %_, %_` no longer
 * distinguishes `x = x + y` from `x = y + y`), but far stronger than the
 * bare mnemonic-only `fuzzy` tier: every non-register operand — string,
 * immediate, bigint, branch target, switch case — stays exact and in
 * position, so this only recognises a function whose *only* difference from
 * another build is which physical registers it happened to use.
 */
export function regMaskedFunctionSignature(mod: HbcModule, fn: DecodedFunction): string {
  return buildNormalisedLines(mod, fn, maskedRegNamer()).join("\n");
}
