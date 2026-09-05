// literal-forms checker -- spec 23 section 3.2.
//
// Both sub-forms are effect-neutral, but for two different reasons stated
// here rather than left to the generic effect model (item 1): L-T (T1/T2/T3)
// never touches the effect sequence at all -- `typeof`/`bin`/`logical` carry
// no effects -- so `effectSequence(before) === effectSequence(after)`
// exactly; L-R deletes exactly the `new RegExp` construction effect, which
// is sound only because `new RegExp(p, f)` and `/p/f` both allocate a fresh
// RegExp with the same `source`/`flags`/`lastIndex`.
import type { Effect, Stmt } from "../ast.ts";
import { effectSequence, freeNames, parses } from "../ast.ts";
import type { CheckResult } from "../types.ts";

function sameEffect(a: Effect, b: Effect): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `after` is `before` with exactly one `k:"new"` effect removed (any
 *  position) -- tries every removable `new` in turn, since `check` is not
 *  told which site fired. */
function isExactlyOneNewEffectDropped(before: readonly Effect[], after: readonly Effect[]): boolean {
  if (before.length !== after.length + 1) return false;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.k !== "new") continue;
    const candidate = [...before.slice(0, i), ...before.slice(i + 1)];
    if (candidate.length === after.length && candidate.every((e, j) => sameEffect(e, after[j]!))) return true;
  }
  return false;
}

export function check(before: readonly Stmt[], after: readonly Stmt[]): CheckResult {
  if (!parses(after)) return { ok: false, reason: "after does not parse" };
  const be = effectSequence(before);
  const ae = effectSequence(after);
  const same = be.length === ae.length && be.every((e, i) => sameEffect(e, ae[i]!));
  if (!same && !isExactlyOneNewEffectDropped(be, ae)) {
    return { ok: false, reason: "the rewrite changed the observable effect sequence by more than one RegExp construction" };
  }
  const freeBefore = freeNames(before);
  for (const n of freeNames(after)) {
    if (!freeBefore.has(n)) return { ok: false, reason: `after introduces a free name not free in before: ${n}` };
  }
  return { ok: true };
}
