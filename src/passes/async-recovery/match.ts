// §3.1 — one site per async group: the spawn wrapper, the `generator: true`
// factory `yield-recovery` produced inside it, and the driver call. F1: the
// site is the statement list that declares the stub.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { recover } from "./recover.ts";
import type { Recovered } from "./recover.ts";

export interface AsyncSite {
  readonly index: number;
  readonly recovered: Recovered;
}

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], AsyncSite> | null {
  // PL-08 / R-A0: no spawn wrapper here, answered without reading the context.
  if (ctx.fnBody === undefined || list !== ctx.fnBody) return null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.k !== "func") continue;
    const r = recover(s);
    if (!r.ok) {
      ctx.refuse?.(s, r.reason); // §5: a counted refusal, never a wrong rewrite.
      continue;
    }
    return { root: list, nodes: [[list[i]!]], data: { index: i, recovered: r }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
  }
  return null;
}
