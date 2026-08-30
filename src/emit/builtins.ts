// docs/specs/05-emitter.md §7.3 — `CallBuiltin` / `GetBuiltinClosure`.
//
// The builtin *number* is version-dependent (docs/HBC-FORMAT.md §11.4:
// `spawnAsync` is 52 at v94 and 57 at v99), so it is always resolved through the
// generated table for the module's own version, never hard-coded.
//
// Two kinds of entry:
//   * a real JS global (`Math.floor`, `JSON.stringify`, `Object.keys`, …) —
//     emitted directly, no helper;
//   * a runtime intrinsic (`arraySpread`, `copyDataProperties`, `spawnAsync`, …)
//     — emitted as the matching `__hbc_b_*` helper (src/runtime/helpers.ts).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { BuiltinDef } from "../tables/types.ts";
import type { Expr } from "./ast.ts";
import { id, member } from "./ast.ts";

/** Intrinsic name -> helper name. Anything not here must have `object`/`method`. */
const INTRINSIC_HELPERS: Readonly<Record<string, string>> = {
  apply: "__hbc_b_apply",
  applyArguments: "__hbc_b_applyArguments",
  applyWithNewTarget: "__hbc_b_applyWithNewTarget",
  arraySpread: "__hbc_b_arraySpread",
  awaitAsyncGenerator: "__hbc_b_awaitAsyncGenerator",
  copyDataProperties: "__hbc_b_copyDataProperties",
  copyRestArgs: "__hbc_b_copyRestArgs",
  ensureObject: "__hbc_b_ensureObject",
  exportAll: "__hbc_b_exportAll",
  functionPrototypeApply: "__hbc_b_functionPrototypeApply",
  functionPrototypeCall: "__hbc_b_functionPrototypeCall",
  generatorSetDelegated: "__hbc_b_generatorSetDelegated",
  getMethod: "__hbc_b_getMethod",
  getTemplateObject: "__hbc_b_getTemplateObject",
  initRegexNamedGroups: "__hbc_b_initRegexNamedGroups",
  makeAsyncIterator: "__hbc_b_makeAsyncIterator",
  requireFast: "__hbc_b_requireFast",
  silentSetPrototypeOf: "__hbc_b_silentSetPrototypeOf",
  spawnAsync: "__hbc_b_spawnAsync",
  throwReferenceError: "__hbc_b_throwReferenceError",
  throwTypeError: "__hbc_b_throwTypeError",
};

/**
 * `exponentiationOperator` is deliberately *not* a helper: it is `a ** b`, which
 * has a direct JS surface form, and §7.1's policy forbids a helper for anything
 * that does.
 */
export const INLINE_INTRINSICS: ReadonlySet<string> = new Set(["exponentiationOperator"]);

export interface BuiltinTarget {
  /** The callee expression. */
  readonly callee: Expr;
  /** `this` for the call: the namespace object for `JSON.stringify`, else undefined. */
  readonly receiver: Expr | null;
  /** Helper this call needs emitted, if any. */
  readonly helper: string | null;
}

export function resolveBuiltin(def: BuiltinDef | undefined, number: number, functionIndex: number, offset: number): BuiltinTarget {
  if (def === undefined) {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `builtin number ${number} is not in this module's builtin table`, { functionIndex, offset, section: "emit/builtins" });
  }
  if (def.object !== undefined && def.method !== undefined) {
    if (def.object === "globalThis") return { callee: id(def.method), receiver: null, helper: null };
    const obj = id(def.object);
    return { callee: member(obj, { k: "lit", text: def.method }, false), receiver: obj, helper: null };
  }
  if (INLINE_INTRINSICS.has(def.name)) {
    throw new Hbc2jsError(ErrorCode.E_INTERNAL, `builtin ${def.name} is inlined, not called through resolveBuiltin`, { functionIndex, offset, section: "emit/builtins" });
  }
  const helper = INTRINSIC_HELPERS[def.name];
  if (helper === undefined) {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `no lowering for internal builtin "${def.name}" (number ${number})`, { functionIndex, offset, section: "emit/builtins" });
  }
  return { callee: id(helper), receiver: null, helper };
}
