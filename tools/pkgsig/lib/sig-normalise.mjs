// tools/pkgsig/lib/sig-normalise.mjs — pkgsig-local normaliser (T8 prototype v2,
// docs/PACKAGE-SIGNATURES.md §5.1).
//
// A *fork* of src/harness/roundtrip.ts's `normaliseFunction`, not a change to
// it: D3 requires that oracle to stay byte-exact for round-trip diffing, so
// the require()-call-site fix described in docs/PACKAGE-SIGNATURES.md §3.2
// (fallback #2 — "extend normaliseFunction-for-signatures ... to mask every
// imm operand immediately preceding a call to a resolved __d-registered
// require binding") lives here instead, as this repo's own D17-owner-agent
// (M4 owns src/**) has to implement it without touching src/**.
//
// What's added on top of normaliseFunction: every Metro-compiled CommonJS
// factory function receives `(global, require, importDefault, importAll,
// module, exports, dependencyMap)`-shaped parameters with the dependency map
// *always last*, regardless of how many of the earlier ones a given factory
// actually uses (Babel drops unused trailing params, never reorders). A
// `require(d[N])`/`_dependencyMap[N]` call site is therefore always "index N
// into whatever register was just loaded via `LoadParam _, paramCount-1`" —
// compiled either as
//   (a) LoadConst{Zero,UInt8,Int,Double} %i, N ; GetByVal %v, %depmap, %i
//   (b) GetByIndex %v, %depmap, N              (hbc98+, immediate index)
// Both forms bake N as a plain `imm`-role operand, which is exactly the
// bytecode-function-graph-position-dependent integer identified in
// docs/PACKAGE-SIGNATURES.md §2.4/§3.2 as the cause of react/react-native's
// exact-hash misses: N is "the Nth thing this module requires", stable
// across rebuilds of the *same* module in isolation, but not stable across a
// standalone single-package bundle vs. the same code re-bundled as part of a
// larger app (a different position in the *global* module graph changes
// nothing about the require-call's *local* dependency-slot index — so this
// masking is exactly the fix, without needing full §3.1 module-graph
// resolution to run first: it only needs the enclosing function's own param
// count, which decodeFunction already gives us).
//
// A local, forked copy of the operand-printing helpers is deliberately used
// (not an import from src/harness/roundtrip.ts's private functions, which
// aren't exported) so this file has no way to accidentally change the D3
// oracle's own output.

import { getBuiltinTable } from "../../../src/tables/registry.ts";

function builtinName(mod, n) {
  const id = mod.layout.builtinTable;
  if (id === undefined) return "?";
  const table = getBuiltinTable(id);
  return table.builtins.find((b) => b.n === n)?.name ?? "?";
}

function maskedFunctionName(name) {
  return name === "global" ? "global" : "~";
}

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);

/**
 * Local dataflow pass (flat, single forward scan — sufficient because Metro's
 * require-call-site idiom is always straight-line code with no intervening
 * branch between the `LoadParam`/`LoadConst` and the `GetByVal`/`GetByIndex`
 * that consumes them) recovering the set of instruction offsets whose `imm`
 * operand is a dependency-map index and should be masked.
 *
 * Returns a Map<offset, "self" | "load"> — "self" means mask this
 * instruction's own imm operand (the GetByIndex immediate form); "load" means
 * mask the *earlier* LoadConst instruction at that offset (the GetByVal +
 * separate index-register form) — the offset key in both cases is the
 * instruction whose imm operand token gets replaced.
 */
function findDependencyIndexOperands(fn) {
  const lastParamIndex = fn.header.paramCount - 1;
  const masked = new Map();
  // regNumber -> { kind: "depmap" } | { kind: "constimm", offset } | undefined
  const regState = new Map();

  for (const insn of fn.instructions) {
    const ops = insn.operands;

    if (insn.name === "LoadParam" && ops.length >= 2 && ops[0].role === "reg") {
      regState.set(ops[0].value, ops[1].value === lastParamIndex ? { kind: "depmap" } : undefined);
      continue;
    }
    if (LOAD_CONST_NUMERIC.has(insn.name) && ops.length >= 1 && ops[0].role === "reg") {
      regState.set(ops[0].value, { kind: "constimm", offset: insn.offset });
      continue;
    }
    if (insn.name === "GetByVal" && ops.length === 3 && ops[0].role === "reg" && ops[1].role === "reg" && ops[2].role === "reg") {
      const base = regState.get(ops[1].value);
      const idx = regState.get(ops[2].value);
      if (base?.kind === "depmap" && idx?.kind === "constimm") {
        masked.set(idx.offset, "load");
      }
      regState.set(ops[0].value, undefined);
      continue;
    }
    if (insn.name === "GetByIndex" && ops.length === 3 && ops[0].role === "reg" && ops[1].role === "reg" && ops[2].role === "imm") {
      const base = regState.get(ops[1].value);
      if (base?.kind === "depmap") {
        masked.set(insn.offset, "self");
      }
      regState.set(ops[0].value, undefined);
      continue;
    }
    // Conservative invalidation: any instruction whose first operand is a
    // register is assumed to (re)define it, so stale depmap/constimm state
    // for a register number that gets reused for something unrelated is
    // dropped rather than misread later. Never causes a *wrong* mask, only a
    // missed one (falls back to unmasked pre-existing behaviour).
    if (ops.length > 0 && ops[0].role === "reg") {
      regState.set(ops[0].value, undefined);
    }
  }
  return masked;
}

function operandToken(mod, op, insn, fn, regName, maskedImm) {
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
  }
}

function normaliseSwitch(mod, insn, fn) {
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

/**
 * Signature-tier drop-in replacement for src/harness/roundtrip.ts's
 * `normaliseFunction`: byte-identical output for every function that does
 * *not* contain a require-call-site dependency-map index (the overwhelming
 * majority — this only changes output for functions matching the pattern
 * above), and masks the dependency-index immediate for the ones that do.
 */
export function normaliseFunctionForSignature(mod, fn) {
  const regs = new Map();
  const regName = (n) => {
    let r = regs.get(n);
    if (r === undefined) {
      r = `%${regs.size}`;
      regs.set(n, r);
    }
    return r;
  };

  const maskedOffsets = findDependencyIndexOperands(fn);
  const lines = [`fn(${fn.header.paramCount}) ${maskedFunctionName(fn.name)}`];

  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    const prefix = label !== undefined ? `${label}: ` : "";
    if (insn.kind === "switch") {
      lines.push(prefix + normaliseSwitch(mod, insn, fn));
      continue;
    }
    const maskMode = maskedOffsets.get(insn.offset);
    const ops = insn.operands
      .filter((o) => o.role !== "cacheIndex")
      .map((op, idx) => {
        // "self" mode: this instruction's own trailing imm operand (GetByIndex's
        // 3rd operand) is the one to mask. "load" mode: the *whole* instruction
        // is a LoadConst* whose only interesting operand is the immediate
        // itself, so mask it unconditionally when this offset was recorded.
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

  return lines.join("\n");
}
