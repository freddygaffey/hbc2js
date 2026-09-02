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
  // P-11b (docs/PUSHBACK.md P-11, resolved): spec 19 §7's default-on shape
  // landed. P-11a fixed the perf ceiling (7.7-10.7x vs the 12x P-1 limit).
  // This task widened the ~10 downstream rungs' `r\d+\b` regexes to accept
  // `rN_j` split names too (same class of fix as F15's
  // `EMITTER_NAME_CLASS_RE`) — see those test files' diffs for the list.
  // `--optin=<other pass>` / `--passes=` remain the escape hatches for
  // isolating a single pass; there is no longer a reg-split-specific
  // opt-out beyond the general pass-selection CLI surface.
};
