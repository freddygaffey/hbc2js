// tools/pkgsig/lib/dscan.mjs — Metro `__d(factory, id, deps)` module-graph
// recovery (docs/PACKAGE-SIGNATURES.md §3.1/§5.3).
//
// A single forward dataflow scan over the `global` function's decoded
// instructions, recovering, for every `TryGetById "__d"` -> `CreateClosure`
// -> `LoadConst*` -> `NewArray[WithBuffer]` -> `Call4` quintuple (the exact
// shape Metro's Babel transform emits, confirmed directly against real
// react/react-native bundles compiled with hermesc v94 for this task): which
// Hermes function index is that Metro module's factory, its local numeric
// module id, and its declared dependency-id array (decoded from the literal
// buffer via src/parse/buffers.ts's `readLiterals`, already-exported stdlib
// this repo ships — no new src/** parsing code needed). No fingerprinting
// happens here; this only recovers *structure*, used both for the
// module-level fingerprint (§5.3's DB format) and, per docs §3.1, as the
// intended anchor for whole-module matching (not yet wired into match.mjs's
// scoring beyond depCount agreement — see docs/PACKAGE-SIGNATURES.md §5.4).
//
// Heuristic, not a verified-exhaustive decoder: falls back to `depCount:
// null` / `depIds: null` for any deps-array construction shape other than
// `NewArray <n>, 0` (empty) or `NewArrayWithBuffer[Long]` (small-integer
// literal array) — e.g. a >4095-element deps array split across multiple
// literal runs works (readLiterals already handles that), but a
// dynamically-built deps array (never observed in practice — Metro always
// emits a static array here) would not.

import { readLiterals } from "../../../src/parse/buffers.ts";

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);
const GET_BY_ID_LIKE = new Set(["TryGetById", "TryGetByIdLong", "GetById", "GetByIdLong", "GetByIdShort"]);

/**
 * @param mod HbcModule (from parseHbc)
 * @param globalFn DecodedFunction for functionIndex 0 ("global")
 * @returns {Array<{factoryFunctionIndex:number, moduleId:number|null, depCount:number|null, depIds:number[]|null}>}
 */
export function scanModuleRegistrations(mod, globalFn) {
  const regState = new Map();
  const modules = [];

  for (const insn of globalFn.instructions) {
    const ops = insn.operands;

    if (GET_BY_ID_LIKE.has(insn.name)) {
      const strOp = ops.find((o) => o.role === "string");
      if (ops[0]?.role === "reg") {
        const isD = strOp !== undefined && mod.strings.get(strOp.value) === "__d";
        regState.set(ops[0].value, isD ? { kind: "__d" } : undefined);
      }
      continue;
    }

    if ((insn.name === "CreateClosure" || insn.name === "CreateClosureLongIndex") && ops[0]?.role === "reg") {
      const fnOp = ops.find((o) => o.role === "function");
      regState.set(ops[0].value, fnOp !== undefined ? { kind: "factory", index: fnOp.value } : undefined);
      continue;
    }

    if (LOAD_CONST_NUMERIC.has(insn.name) && ops[0]?.role === "reg") {
      const value = insn.name === "LoadConstZero" ? 0 : (ops[1]?.value ?? null);
      regState.set(ops[0].value, { kind: "id", value });
      continue;
    }

    if (insn.name === "NewArray" && ops[0]?.role === "reg") {
      const sizeHint = ops[1]?.value ?? -1;
      regState.set(ops[0].value, { kind: "deps", ids: sizeHint === 0 ? [] : null });
      continue;
    }

    if ((insn.name === "NewArrayWithBuffer" || insn.name === "NewArrayWithBufferLong") && ops[0]?.role === "reg") {
      const numLiterals = ops[2]?.value ?? 0;
      const litOp = ops.find((o) => o.role === "literalOffset");
      let ids = null;
      if (litOp !== undefined) {
        try {
          const { values } = readLiterals(mod.literalValueBuffer, litOp.value, numLiterals);
          ids = values.map((v) => (v.kind === "integer" || v.kind === "number" ? v.value : null));
        } catch {
          ids = null;
        }
      }
      regState.set(ops[0].value, { kind: "deps", ids });
      continue;
    }

    if ((insn.name === "Call4" || insn.name === "Call5") && ops.length >= 6) {
      const callee = regState.get(ops[1].value);
      if (callee?.kind === "__d") {
        const factory = regState.get(ops[3].value);
        const id = regState.get(ops[4].value);
        const deps = regState.get(ops[5].value);
        if (factory?.kind === "factory") {
          modules.push({
            factoryFunctionIndex: factory.index,
            moduleId: id?.kind === "id" ? id.value : null,
            depCount: deps?.kind === "deps" && deps.ids !== null ? deps.ids.length : null,
            depIds: deps?.kind === "deps" ? deps.ids : null,
          });
        }
      }
      if (ops[0]?.role === "reg") regState.set(ops[0].value, undefined);
      continue;
    }

    if (ops.length > 0 && ops[0].role === "reg") {
      regState.set(ops[0].value, undefined);
    }
  }

  return modules;
}
