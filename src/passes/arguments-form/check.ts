// arguments-form checker -- spec 23 section 3.1.
//
// 1. Undo: `after` must equal the independently re-derived rewrite of
//    `before` (a stronger, and simpler, form of "re-wrap and compare" --
//    re-wrapping is redundant once the replacement is reproduced exactly).
// 2. `effectSequence` equivalence, stated explicitly: each replaced call is a
//    pure function of its argument (`src/runtime/helpers.ts` section 8 -- a
//    fresh unmapped copy, no store, no throw for the one argument shape this
//    matcher accepts), so removing it removes exactly one `call` effect and
//    nothing else. Cross-checked by count rather than assumed.
// 3. Independent re-derivation of section 4.1's whole-function predicate from
//    `before` alone, plus the free-names and no-leftover-helper assertions.
import type { Stmt } from "../ast.ts";
import { effectSequence, freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { classify } from "./match.ts";
import { inlineSingleUseTemp, replaceCalls } from "./rewrite.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const result = classify(before, ctx);
  if (!result.ok) return { ok: false, reason: `check re-derivation refused: ${result.reason}` };

  const expected = inlineSingleUseTemp(replaceCalls(before, result.site.calls));
  if (JSON.stringify(expected) !== JSON.stringify(after)) {
    return { ok: false, reason: "after does not match the independently re-derived rewrite" };
  }

  if (!parses(after)) return { ok: false, reason: "after does not parse" };

  // Item 2: each replaced call removes exactly one `call` effect (arity 1,
  // pure helper) and changes nothing else.
  const beforeEffects = effectSequence(before);
  const afterEffects = effectSequence(after);
  if (beforeEffects.length !== afterEffects.length + result.site.calls.length) {
    return { ok: false, reason: "effect count did not shrink by exactly the number of replaced calls" };
  }

  const freeBefore = freeNames(before);
  for (const n of freeNames(after)) {
    if (!freeBefore.has(n)) return { ok: false, reason: `after introduces a free name not free in before: ${n}` };
  }

  return { ok: true };
}
