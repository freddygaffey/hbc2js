// src/split/rewrite.ts — D17i stage 1's `require(<depId>)` rewrite. In the
// M4 baseline (no readability passes — src/split runs the pipeline with
// passes off, D22/D12a out of scope here, see docs/AGENT-LOG.md for why),
// Metro's `require(dependencyMap[i])` call decompiles to
// `Reflect.apply(<requireParam-copy>, undefined, [<dependencyMapParam>[i]])`.
// This rewrites each recognised call, in place in the statement, to
// `require('./module_<depIds[i]>.js')` — a real, readable require() edge.
// Top-level statements of the factory body only; see src/split/tag.ts.
import type { Expr, Stmt } from "../emit/ast.ts";
import { classify, isReflectApply, type Tag } from "./tag.ts";

export interface RewriteResult {
  readonly body: readonly Stmt[];
  readonly rewrites: number;
}

function requireCallFor(depId: number): Expr {
  return { k: "call", callee: { k: "ident", name: "require" }, args: [{ k: "lit", text: JSON.stringify(`./module_${depId}.js`) }] };
}

export function rewriteFactoryBody(body: readonly Stmt[], params: readonly string[], depIds: readonly number[]): RewriteResult {
  const requireParam = params[1];
  const depMapParam = params[params.length - 1];
  const paramNames = new Set(params);
  const regs = new Map<string, Tag>();
  let rewrites = 0;

  const matchRequireCall = (call: Extract<Expr, { k: "call" }>): number | null => {
    if (requireParam === undefined || depMapParam === undefined || depIds.length === 0) return null;
    if (!isReflectApply(call.callee) || call.args.length !== 3) return null;
    const fnTag = classify(call.args[0]!, regs, paramNames);
    if (!(fnTag.kind === "param" && fnTag.name === requireParam)) return null;
    const arr = call.args[2]!;
    if (arr.k !== "array" || arr.elements.length !== 1) return null;
    const idxTag = classify(arr.elements[0]!, regs, paramNames);
    if (!(idxTag.kind === "prop" && idxTag.objTag !== null && idxTag.objTag.kind === "param" && idxTag.objTag.name === depMapParam && /^\d+$/.test(idxTag.name))) return null;
    const idx = Number(idxTag.name);
    return idx >= 0 && idx < depIds.length ? idx : null;
  };

  const out = body.map((s): Stmt => {
    if (s.k === "init") {
      if (s.value.k === "call") {
        const idx = matchRequireCall(s.value);
        regs.set(s.name, { kind: "other" });
        if (idx !== null) {
          rewrites++;
          return { ...s, value: requireCallFor(depIds[idx]!) };
        }
        return s;
      }
      regs.set(s.name, classify(s.value, regs, paramNames));
      return s;
    }
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") {
      const name = s.expr.target.name;
      if (s.expr.value.k === "call") {
        const idx = matchRequireCall(s.expr.value);
        regs.set(name, { kind: "other" });
        if (idx !== null) {
          rewrites++;
          return { ...s, expr: { ...s.expr, value: requireCallFor(depIds[idx]!) } };
        }
        return s;
      }
      regs.set(name, classify(s.expr.value, regs, paramNames));
      return s;
    }
    if (s.k === "expr" && s.expr.k === "call") {
      const idx = matchRequireCall(s.expr);
      if (idx !== null) {
        rewrites++;
        return { ...s, expr: requireCallFor(depIds[idx]!) };
      }
      return s;
    }
    return s;
  });
  return { body: out, rewrites };
}
