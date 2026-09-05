// private-fields checker. Independent re-derivation (never trust the writer's
// own data): recompute `foldAll(before)` and require exactly the same result,
// then the two obligations a field-declaration rewrite must keep -- no new
// free name (every reference this rung deletes is one it also replaces with
// an equivalent, so nothing a class body still needs can go missing), and the
// result still parses. `AddOwnPrivateBySym`/`Get/PutOwnPrivateBySym`/
// `PrivateIsIn` have no other observable side effect to preserve (unlike
// class-recover's method installs, a private-name declare-and-initialise
// *is* exactly a class field declaration's own semantics -- there is no
// third form to diff against), so this checker does not need
// `effectSequence`.
import type { Stmt } from "../ast.ts";
import { freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { foldAll } from "./match.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const rebuilt = foldAll(before);
  if (rebuilt.folded.length === 0) return { ok: false, reason: "private-fields produced no name to re-derive" };
  if (rebuilt.after.length !== after.length) return { ok: false, reason: "private-fields changed a statement count the re-derived fold does not account for" };
  for (let i = 0; i < after.length; i++) {
    if (!sameStmt(rebuilt.after[i]!, after[i]!)) return { ok: false, reason: `private-fields rewrote statement ${i} differently from its own re-derivation` };
  }
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) if (!beforeFree.has(name)) return { ok: false, reason: `private-fields introduced the free name ${name}` };
  if (!parses(after)) return { ok: false, reason: "private-fields produced a body that does not parse" };
  return { ok: true };
}
