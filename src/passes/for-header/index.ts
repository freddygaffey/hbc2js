import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ForSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `init; while (c) { …; step }` -> `for (init; c; step) { … }`. */
export const forHeader: Pass<Stmt, ForSite> = {
  name: "for-header",
  stage: "A",
  targets: ["04-for-loop-basic", "11-nested-loops-mixed"],
  catalogue: [4],
  after: ["loop-cond"],
  match,
  rewrite,
  check,
};
