// try-clean matcher — spec 22 §4.2. F1: one site, the whole current function
// body (`list === ctx.fnBody`), so the liveness reasoning is whole-function
// and the rung is a one-shot fixed point (PL-08: after a successful rewrite
// C3 fails on every `try` this rung touched, so the second run matches
// nothing).
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { analyze } from "./analysis.ts";
import type { Analysis } from "./analysis.ts";

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], Analysis> | null {
  if (list !== ctx.fnBody) return null;
  const a = analyze(list);
  if (!a.ok) return null;
  return { root: list, nodes: [list], data: a, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
