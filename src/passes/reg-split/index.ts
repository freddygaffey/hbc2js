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
 *  `after`: every rung that deletes, folds or absorbs registers (spec §7) —
 *  `reg-split` must see the tree they leave behind, not waste analysis on
 *  registers about to vanish. `before: ["var-naming"]` is the consumer. */
export const regSplit: Pass<readonly Stmt[], RegSplitSite> = {
  name: "reg-split",
  stage: "B",
  targets: ["04-for-loop-basic", "02-while-loop", "11-nested-loops-mixed", "14-nested-try-catch", "22-nested-closures-counters"],
  catalogue: ["R9"],
  after: ["expr-rebuild", "call-shape", "global-access", "fn-naming", "template-literal", "default-params", "destructure", "spread-rest", "optional-chain"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
  // PUSHBACK P-? (docs/PUSHBACK.md): spec 19 §7 says `optIn` is *not* set —
  // the pass should run in the default pipeline. Landed `optIn: true`
  // instead: sound (16/16 rung tests green, all five §10 target fixtures
  // 0-DIVERGENT, the full construct suite crash-free with the pass on), but
  // turning it on by default trips two gates this task's budget did not
  // cover fixing: (1) `tests/gate/passes/pipeline-speed.test.ts` P-1's
  // 12x CPU ceiling (measured 13.6x on rn-template after one optimisation
  // pass — the R-catch/R-loop pre-coarsening in `match.ts` is still O(regs
  // x tries) per function, not O(occurrences)); (2) roughly ten existing
  // passes' own tests assert `r\d+\b`-shaped regexes against real-fixture
  // output and now see `rN_j` names for a register reg-split legitimately
  // split (CONSOLIDATION §B's documented "every new rung breaks the
  // previous rungs' string assertions" debt) — each needs its regex
  // widened the same way F15 already widened `EMITTER_NAME_CLASS_RE`, one
  // pass file at a time, reviewed as its own change. `--passes=reg-split`
  // (or `--optin=reg-split`) exercises it directly.
  optIn: true,
};
