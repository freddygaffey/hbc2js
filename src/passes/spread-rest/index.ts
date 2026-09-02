import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { SpreadRestSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** The helper-call spread forms (`__hbc_b_arraySpread`, `__hbc_b_apply`,
 *  `__hbc_b_copyRestArgs`, 2-argument `__hbc_b_copyDataProperties`) -> `...`
 *  — docs/LOWERING-CATALOGUE.md row 23, docs/specs/passes/17-spread-rest.md.
 *
 *  `after: ["destructure"]` (spec §7 / spec 16 §7's ownership table):
 *  declared-order hygiene, not a data dependency — the two rungs' matchers
 *  are shape-disjoint (the 2- vs 3-argument `copyDataProperties` arg count
 *  is the discriminator, checked in both `match` and `check`), but running
 *  after `destructure` keeps this rung's residual-site metric honest (the
 *  iterator-protocol runs that are pattern-rest, not spread, are already
 *  gone by the time this rung looks). */
export const spreadRest: Pass<readonly Stmt[], SpreadRestSite> = {
  name: "spread-rest",
  stage: "B",
  targets: ["40-spread-array", "41-spread-object", "42-rest-params"],
  catalogue: [23],
  after: ["expr-rebuild", "global-access", "call-shape", "destructure"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
};
