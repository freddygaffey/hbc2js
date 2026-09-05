// globalthis-dead-store matcher. F1: one site, the whole current function
// body (`list === ctx.fnBody`), so the liveness reasoning (`identUses` over
// the whole function) is whole-function and the rung is a one-shot fixed
// point (a successful rewrite deletes every dead store in one go).
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { analyze } from "./analysis.ts";
import type { Analysis } from "./analysis.ts";

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], Analysis> | null {
  if (list !== ctx.fnBody) return null;
  const a = analyze(list);
  if (a.deadStores.size === 0) return null;
  return { root: list, nodes: [list], data: a, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
