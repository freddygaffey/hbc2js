// docs/specs/passes/25-yield-async-recovery.md §3.1 — one site per *generator
// group* in the current function body. F1: the site is the statement list that
// declares the stub, because the whole group (the stub, the factory it
// declares, and the `sameFrame` step closure that factory returns) is visible
// from there and nowhere else.
import type { Stmt } from "../../emit/ast.ts";
import type { Match, PassContext } from "../types.ts";
import { recover } from "./recover.ts";
import type { Recovered } from "./recover.ts";

export interface YieldSite {
  /** Index of the stub `k:"func"` statement in the site list. */
  readonly index: number;
  readonly recovered: Recovered;
}

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], YieldSite> | null {
  // PL-08 fixed point: a body with no generator group is answered without
  // consulting the context at all.
  if (ctx.fnBody === undefined || list !== ctx.fnBody) return null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.k !== "func") continue;
    const r = recover(s);
    if (!r.ok) continue; // §4: a counted refusal, never a wrong rewrite.
    return { root: list, nodes: [[list[i]!]], data: { index: i, recovered: r }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
  }
  return null;
}
