import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { LabelSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** IR hygiene, not idiom recovery (catalogue row R8): drops an unused
 *  `labeled` wrapper (L1), unwraps one whose only uses are tail `break`s
 *  (L2), hides a loop's label once nothing needs it unlabelled any more
 *  (L3), and unwraps a one-element `seq` a rewrite left behind (L4). Last in
 *  stage A — every other stage-A rung removes label uses. */
export const labelClean: Pass<Stmt, LabelSite> = {
  name: "label-clean",
  stage: "A",
  targets: ["08-labeled-break-continue", "11-nested-loops-mixed", "02-while-loop"],
  catalogue: ["R8"],
  after: ["loop-cond", "for-header"],
  match,
  rewrite,
  check,
};
