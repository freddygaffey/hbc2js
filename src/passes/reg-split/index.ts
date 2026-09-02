import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { RegSplitSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Splits each register's disjoint live ranges ("webs") into separate `rN`/
 *  `rN_2`/… variables — docs/LOWERING-CATALOGUE.md row R9,
 *  docs/specs/passes/19-reg-split.md. Stage B, pure alpha-renaming: no
 *  statement moves, no expression changes shape, no value is computed
 *  differently. Runs immediately before `var-naming`, which is the whole
 *  point (spec §7): a register with one def-web per name passes
 *  `var-naming`'s single-def/single-role gate where the same register with
 *  every unrelated job sharing one name could not.
 *
 *  `after`: every rung that deletes, folds or absorbs registers (spec §7),
 *  plus `jsx-recover` (D20's stage boundary: the opt-in structure rung must
 *  see original register identity before `reg-split` renames it, so
 *  `reg-split` must run after it) — `reg-split` must see the tree they leave
 *  behind, not waste analysis on registers about to vanish. `before:
 *  ["var-naming"]` is the consumer. */
export const regSplit: Pass<readonly Stmt[], RegSplitSite> = {
  name: "reg-split",
  stage: "B",
  targets: ["04-for-loop-basic", "02-while-loop", "11-nested-loops-mixed", "14-nested-try-catch", "22-nested-closures-counters"],
  catalogue: ["R9"],
  after: ["expr-rebuild", "call-shape", "global-access", "fn-naming", "template-literal", "default-params", "destructure", "spread-rest", "optional-chain", "jsx-recover"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
  // PUSHBACK P-11 (docs/PUSHBACK.md), resolved 2026-09-02 (D20,
  // docs/DECISIONS.md): spec 19 §7 says `optIn` is *not* set — the pass
  // should run in the default pipeline. P-11a fixed the perf ceiling
  // (7.7-10.7x vs the 12x P-1 limit); P-11b widened the ~10 downstream
  // rungs' `r\d+\b` regexes to accept `rN_j` split names too (F15-class
  // fix), then found a real regression on the default-on flip: with
  // reg-split running *before* `jsx-recover`, its renaming of an
  // object-literal-build register into per-store copies (`r3`, `r3_2`,
  // `r3_3`, ...) broke the call-shape `jsx-recover`'s matcher keys off
  // (docs/BUGS.md's 2026-09-02 P-11b row). D20 fixes the root cause instead
  // of working around it: `jsx-recover` is a *structure-recovery* rung, so
  // it belongs in the structure-recovery block, which `registry.ts` now
  // runs entirely before the renaming block `reg-split` opens. `reg-split`
  // no longer runs before any structure rung, so it is safe to default on.
  optIn: false,
};
