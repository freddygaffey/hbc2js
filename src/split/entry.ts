// src/split/entry.ts — find the Metro entry module id from the bundle's
// global function: the last `<globalObj>.__r(<literal id>)` call (Metro's
// `require(entryId)`, run after every `__d()` registration). Best-effort,
// top-level statements only — see src/split/tag.ts's header comment.
import type { Expr, Stmt } from "../emit/ast.ts";
import { classify, isReflectApply, type Tag } from "./tag.ts";

function assignedIdent(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

export function resolveEntryModuleId(globalBody: readonly Stmt[]): number | null {
  const regs = new Map<string, Tag>();
  const noParams = new Set<string>();
  let lastEntry: number | null = null;

  const checkCall = (call: Extract<Expr, { k: "call" }>): void => {
    if (!isReflectApply(call.callee) || call.args.length !== 3) return;
    const fnTag = classify(call.args[0]!, regs, noParams);
    if (!(fnTag.kind === "prop" && fnTag.name === "__r")) return;
    const arr = call.args[2]!;
    if (arr.k !== "array" || arr.elements.length !== 1) return;
    const argTag = classify(arr.elements[0]!, regs, noParams);
    if (argTag.kind === "num") lastEntry = argTag.value;
  };

  for (const s of globalBody) {
    const at = assignedIdent(s);
    if (at !== null) {
      if (at.value.k === "call") {
        checkCall(at.value);
        regs.set(at.name, { kind: "other" });
      } else {
        regs.set(at.name, classify(at.value, regs, noParams));
      }
      continue;
    }
    if (s.k === "expr" && s.expr.k === "call") checkCall(s.expr);
  }
  return lastEntry;
}
