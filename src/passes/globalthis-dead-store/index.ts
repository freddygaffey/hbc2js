import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import type { Analysis } from "./analysis.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, expression-only deleting rung (docs/LOWERING-CATALOGUE.md R11,
 * docs/specs/passes/03-global-access.md section 5): deletes the `rN =
 * globalThis` store `global-access` leaves behind once its last guarded
 * read has folded to a bare identifier and nothing else reads the register.
 *
 * `after: ["expr-rebuild", "global-access"]`: the deadness this rung acts on
 * exists only once `global-access` has folded the guarded read away.
 * `before: ["fn-naming", "reg-split", "var-naming"]`, the `try-clean`/R8
 * pattern: a register this rung's deletion exposes as dead must never reach
 * a renaming rung first, or `reg-split` numbers the (still-live) other webs
 * of that register starting from `_2` instead of the bare name, leaving a
 * numbering gap for no reason. Registered immediately after `global-access`,
 * before every other stage-B rung, since it has no dependency on anything
 * `call-shape` onward does.
 */
export const globalthisDeadStore: Pass<readonly Stmt[], Analysis> = {
  name: "globalthis-dead-store",
  stage: "B",
  targets: ["19-var-hoisting"],
  catalogue: ["R11"],
  after: ["expr-rebuild", "global-access"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
