// src/deps/dscan.ts — Metro `__d(factory, id, deps)` module-graph recovery.
//
// Promoted from `tools/pkgsig/lib/dscan.mjs` (D17/T8 prototype) into typed
// `src/deps/**` per this milestone's task boundary. Behaviour is unchanged
// from the prototype (docs/PACKAGE-SIGNATURES.md §3.1/§5.3): a single
// forward dataflow scan over the `global` function's decoded instructions,
// recovering every `TryGetById "__d"` -> `CreateClosure` -> `LoadConst*` ->
// `NewArray[WithBuffer]` -> `Call4`/`Call5` quintuple Metro's Babel
// transform emits. This is the module-inventory anchor D17a/D19 both need:
// which Hermes function index is a Metro module's factory, its local
// numeric module id, and its ordered dependency-id array — recovered
// structurally, with no fingerprinting/signature lookup involved.
//
// Heuristic, not a verified-exhaustive decoder: falls back to `depCount:
// null` / `depIds: null` for any deps-array construction shape other than
// `NewArray <n>, 0` (empty) or `NewArrayWithBuffer[Long]` (small-integer
// literal array).

import { readLiterals } from "../parse/buffers.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction } from "../disasm/decode.ts";

export interface ModuleRegistration {
  readonly factoryFunctionIndex: number;
  readonly moduleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
}

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);
const GET_BY_ID_LIKE = new Set(["TryGetById", "TryGetByIdLong", "GetById", "GetByIdLong", "GetByIdShort"]);

type RegState = { readonly kind: "__d" } | { readonly kind: "factory"; readonly index: number } | { readonly kind: "id"; readonly value: number | null } | { readonly kind: "deps"; readonly ids: readonly number[] | null } | undefined;

/**
 * Scan `global`'s (function index 0) decoded instructions for every
 * `__d(factory, id, deps)` registration call.
 */
export function scanModuleRegistrations(mod: HbcModule, globalFn: DecodedFunction): ModuleRegistration[] {
  const regState = new Map<number, RegState>();
  const modules: ModuleRegistration[] = [];

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
      let ids: (number | null)[] | null = null;
      if (litOp !== undefined) {
        try {
          const { values } = readLiterals(mod.literalValueBuffer, litOp.value, numLiterals);
          ids = values.map((v) => (v.kind === "integer" || v.kind === "number" ? v.value : null));
        } catch {
          ids = null;
        }
      }
      regState.set(ops[0].value, { kind: "deps", ids: ids as readonly number[] | null });
      continue;
    }

    if ((insn.name === "Call4" || insn.name === "Call5") && ops.length >= 6) {
      const callee = regState.get(ops[1]!.value);
      if (callee?.kind === "__d") {
        const factory = regState.get(ops[3]!.value);
        const id = regState.get(ops[4]!.value);
        const deps = regState.get(ops[5]!.value);
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

    if (ops.length > 0 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, undefined);
    }
  }

  return modules;
}
