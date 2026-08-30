import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { FnNamingSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Rename a generated `_fnN` top-level binding (and every reference to it,
 *  including a recursive self-reference inside its own body) to a readable
 *  name recovered from the bytecode's own function-name table, or — when
 *  that is empty — the one property/variable it is unambiguously assigned to
 *  — docs/LOWERING-CATALOGUE.md row R4, docs/specs/passes/05-fn-naming.md.
 *  Stage B, pure alpha-renaming: no statement moves, no expression changes
 *  shape.
 *
 *  `after: ["expr-rebuild", "global-access"]` (spec §7): the rename must see
 *  the free global names `global-access` exposes, or condition 4
 *  ("captures-free-name") cannot protect them.
 *
 *  `before: ["class-recover"]` and "before `var-naming`" (spec §7) are
 *  deliberately **not** declared — the same reason `global-access/index.ts`
 *  and `call-shape/index.ts` omit their own forward-looking `before`s:
 *  neither rung is registered yet, and `registry.ts`'s `enabledPasses`
 *  validates every `after`/`before` name against the *actual* registry,
 *  throwing `E_PASS_ORDER` for a dependency on a pass that exists nowhere in
 *  it. When either lands, the ordering should be enforced from its own side
 *  (`after: ["fn-naming"]`). */
export const fnNaming: Pass<readonly Stmt[], FnNamingSite> = {
  name: "fn-naming",
  stage: "B",
  targets: ["19-var-hoisting", "21-iife-closures", "22-nested-closures-counters", "17-closure-loop-var"],
  catalogue: ["R4"],
  after: ["expr-rebuild", "global-access"],
  match,
  rewrite,
  check,
};
