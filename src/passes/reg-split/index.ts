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
  // PUSHBACK P-11 (docs/PUSHBACK.md): spec 19 §7 says `optIn` is *not* set —
  // the pass should run in the default pipeline. P-11a fixed the perf
  // ceiling (7.7-10.7x vs the 12x P-1 limit); this task (P-11b) widened the
  // ~10 downstream rungs' `r\d+\b` regexes to accept `rN_j` split names too
  // (F15-class fix), then attempted the default-on flip and found a real
  // regression it does NOT loosen a test to hide: with reg-split in the
  // default set, `jsx-recover` (`--jsx`) stops recovering JSX on
  // `59-jsx-runtime-calls` at both v94 and v99 — reg-split's renaming of an
  // object-literal-build register into per-store copies (`r3`, `r3_2`,
  // `r3_3`, ...) breaks the def-use pattern jsx-recover's matcher (and/or
  // the object-literal-merge step it depends on) keys off, so JSX elements
  // that recover cleanly without reg-split (`<_e0_2 style={r6}>hello</_e0_2>`)
  // stay as plain calls/property-assignments with it on. Confirmed by
  // running the fixture through `decompile()` with `skip: ["reg-split"]` vs
  // without: JSX recovers in the former, not the latter, both versions.
  // This is a genuine downstream-pass misbehaviour on split registers, not
  // a naming-shape regex needing a widen — `optIn` stays `true` until a
  // reviewed fix lands (either jsx-recover's matcher learns to see through
  // reg-split's per-store register copies, or reg-split runs after
  // jsx-recover in the pipeline order). See docs/BUGS.md's
  // jsx-recover/reg-split row.
  optIn: true,
};
