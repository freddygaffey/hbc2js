// src/split/tag.ts — a tiny, top-level-only copy-propagation used by
// src/split/index.ts to recognise two shapes in the M4-baseline (no readability
// passes) decompiled output, where every call is `Reflect.apply(callee, this,
// args)` and every dependency access is `dependencyMapParam[i]`:
//   1. the bundle's `__r(<entryId>)` call at the end of the global function
//      (docs/DECISIONS.md D19's "entry module becomes index.js").
//   2. each Metro factory's `require(dependencyMap[i])` calls, so they can be
//      rewritten to `require('./module_<depIds[i]>.js')` (D17i stage 1).
// Deliberately narrow: only chases simple `ident`/`init` copies and one level
// of member reads through a per-statement-list register map. A statement
// shape it doesn't recognise just leaves the original Reflect.apply call
// alone — correct but unrewritten (a prototype limitation, not a bug: see
// docs/AGENT-LOG.md).
import type { Expr } from "../emit/ast.ts";

export type Tag = { readonly kind: "num"; readonly value: number } | { readonly kind: "param"; readonly name: string } | { readonly kind: "prop"; readonly objTag: Tag | null; readonly name: string } | { readonly kind: "other" };

const OTHER: Tag = { kind: "other" };

/** Classify one expression given the registers already classified so far and
 *  the current function's own parameter names (a bare reference to a param is
 *  tagged directly — Metro's factory params are never reassigned before use
 *  in the shapes this module looks for). */
export function classify(value: Expr, regs: ReadonlyMap<string, Tag>, paramNames: ReadonlySet<string>): Tag {
  if (value.k === "lit" && /^-?\d+$/.test(value.text)) return { kind: "num", value: Number(value.text) };
  if (value.k === "ident") {
    if (paramNames.has(value.name)) return { kind: "param", name: value.name };
    return regs.get(value.name) ?? OTHER;
  }
  if (value.k === "member") {
    const objTag = value.obj.k === "ident" ? (paramNames.has(value.obj.name) ? ({ kind: "param", name: value.obj.name } as const) : (regs.get(value.obj.name) ?? null)) : null;
    // A literal `.prop` (never `computed`) names itself directly. A
    // `computed` access (`a7[r0]`) needs its index resolved through `regs`
    // too — hermesc materialises the small-int index into its own register
    // one statement earlier (`r0 = 0; r2 = r6[r0]`), it is not inline.
    if (value.prop.k === "lit" && !value.computed) return { kind: "prop", objTag, name: value.prop.text };
    if (value.computed) {
      const propTag = classify(value.prop, regs, paramNames);
      if (propTag.kind === "num") return { kind: "prop", objTag, name: String(propTag.value) };
    }
  }
  return OTHER;
}

export function isReflectApply(callee: Expr): boolean {
  return callee.k === "member" && !callee.computed && callee.obj.k === "ident" && callee.obj.name === "Reflect" && callee.prop.k === "lit" && callee.prop.text === "apply";
}
