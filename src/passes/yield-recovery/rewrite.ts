// §3.3 — the group collapses to one `function*` statement at the stub's
// position. Every surviving sub-expression is carried over by reference, never
// rebuilt, so `check` can compare by re-derivation.
import type { Stmt } from "../ast.ts";
import type { Match } from "../types.ts";
import type { YieldSite } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], YieldSite>): readonly Stmt[] {
  const { index, recovered } = m.data;
  return [...m.root.slice(0, index), recovered.fn, ...m.root.slice(index + 1)];
}
