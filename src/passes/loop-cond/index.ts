import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { LoopSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `while (true) { … if (c) continue/break … }` -> `while (c)` / `do … while (c)`. */
export const loopCond: Pass<Stmt, LoopSite> = {
  name: "loop-cond",
  stage: "A",
  targets: ["02-while-loop", "03-do-while-loop"],
  catalogue: [2, 3],
  match,
  rewrite,
  check,
};
