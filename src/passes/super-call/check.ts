// super-call checker -- docs/specs/passes/28-super-call.md section 7. The same
// three obligations `ctor-this` carries, for the same reason: everything this
// rung touches lives inside a constructor body, which `effectSequence`
// deliberately does not evaluate (`src/passes/ast.ts`, the `class` case).
// (1) Independent re-derivation of `foldAll(before)`; (2) an UNCHANGED
// class-definition effect sequence -- any difference means the rewrite escaped
// the constructor; (3) no new free name (`super` is a keyword the printer
// emits from a `lit`, not a binding) and the result still parses, which is
// also what proves the `super(...)` landed in a derived constructor.
import type { Stmt } from "../ast.ts";
import { effectSequence, freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { foldAll } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const rebuilt = foldAll(before);
  if (rebuilt.folded.length === 0) return { ok: false, reason: "super-call produced no constructor to re-derive" };
  if (rebuilt.after.length !== after.length) return { ok: false, reason: "super-call changed a statement count the re-derived fold does not account for" };
  for (let i = 0; i < after.length; i++) {
    if (rebuilt.after[i] === after[i]) continue;
    if (JSON.stringify(rebuilt.after[i]) !== JSON.stringify(after[i])) return { ok: false, reason: `super-call rewrote statement ${i} differently from its own re-derivation` };
  }
  if (JSON.stringify(effectSequence(after)) !== JSON.stringify(effectSequence(before))) return { ok: false, reason: "super-call changed the class-definition effect sequence" };
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) if (!beforeFree.has(name)) return { ok: false, reason: `super-call introduced the free name ${name}` };
  if (!parses(after)) return { ok: false, reason: "super-call produced a body that does not parse" };
  return { ok: true };
}
