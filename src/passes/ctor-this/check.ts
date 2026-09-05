// ctor-this checker -- docs/specs/passes/26-ctor-this.md section 7.
//
// Three obligations. (1) Independent re-derivation: recompute `foldAll(before)`
// and require the writer's output to equal it statement for statement, so an
// edit outside the constructor bodies this rung declared fails here. (2) The
// class-definition effect sequence is UNCHANGED -- not "changed modulo a
// declared deletion" as class-recover's is, because every statement this rung
// touches lives inside a method body, and `effectSequence` deliberately does
// not evaluate one (`src/passes/ast.ts`, the `class` case: only `extends`,
// computed keys and field initialisers run at class-definition time). Any
// difference at all means the rewrite escaped the constructor. (3) No new free
// name, and the result still parses -- `this` is not a name, so the deleted
// register may never come back as a capture.
import type { Stmt } from "../ast.ts";
import { effectSequence, freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { foldAll } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const rebuilt = foldAll(before);
  if (rebuilt.folded.length === 0) return { ok: false, reason: "ctor-this produced no constructor to re-derive" };
  if (rebuilt.after.length !== after.length) return { ok: false, reason: "ctor-this changed a statement count the re-derived fold does not account for" };
  for (let i = 0; i < after.length; i++) {
    if (rebuilt.after[i] === after[i]) continue;
    if (JSON.stringify(rebuilt.after[i]) !== JSON.stringify(after[i])) return { ok: false, reason: `ctor-this rewrote statement ${i} differently from its own re-derivation` };
  }
  if (JSON.stringify(effectSequence(after)) !== JSON.stringify(effectSequence(before))) return { ok: false, reason: "ctor-this changed the class-definition effect sequence" };
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) if (!beforeFree.has(name)) return { ok: false, reason: `ctor-this introduced the free name ${name}` };
  if (!parses(after)) return { ok: false, reason: "ctor-this produced a body that does not parse" };
  return { ok: true };
}
