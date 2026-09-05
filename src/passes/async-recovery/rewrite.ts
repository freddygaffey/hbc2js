// §3.3 — the group collapses to one `async function` statement at the stub's
// position, carrying the recovered generator's body with every `yield` this
// rung accounted for turned into an `await`.
import type { Stmt } from "../../emit/ast.ts";
import type { Match } from "../types.ts";
import type { AsyncSite } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], AsyncSite>): readonly Stmt[] {
  const { index, recovered } = m.data;
  return [...m.root.slice(0, index), recovered.fn, ...m.root.slice(index + 1)];
}
