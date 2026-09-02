import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { DefaultParamsSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** A defaulted parameter's `arguments[k]` load + `undefined`-guard labeled
 *  block (P-8's real idiom — the spec's original if/else description was
 *  wrong) -> an ES default in the parameter list — docs/LOWERING-CATALOGUE.md
 *  row 24, docs/specs/passes/15-default-params.md.
 *
 *  `after: ["expr-rebuild", "global-access", "call-shape"]` (spec §7):
 *  needs the loads/guards already folded of any surrounding disguise those
 *  rungs would otherwise remove differently, and the call/global shapes
 *  settled before this rung moves statements into the parameter list.
 *  `before: ["var-naming"]` is enforced from `var-naming`'s own side (it
 *  must name `rX` once, in the parameter list, not as a body register this
 *  rung then moves) — `destructure` (16, row 22) is not registered yet, so
 *  its `before` cannot be declared here (`registry.ts` validates every
 *  `after`/`before` name against the actual registry). */
export const defaultParams: Pass<readonly Stmt[], DefaultParamsSite> = {
  name: "default-params",
  stage: "B",
  targets: ["51-default-params", "39-destructuring-params", "42-rest-params"],
  catalogue: [24],
  after: ["expr-rebuild", "global-access", "call-shape"],
  match,
  rewrite,
  check,
};
