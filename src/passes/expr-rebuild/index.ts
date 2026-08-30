import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ExprRebuildSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `rN = E; …; use(rN)` -> `…; use(E)` (and dead-store/self-move cleanup) —
 *  docs/LOWERING-CATALOGUE.md row R1. First in stage B (PL-11): every other
 *  stage-B rung gets `after: ["expr-rebuild"]` injected by `registry.ts`, no
 *  syntactic matcher can see through one-statement-per-instruction. */
export const exprRebuild: Pass<readonly Stmt[], ExprRebuildSite> = {
  name: "expr-rebuild",
  stage: "B",
  targets: ["19-var-hoisting", "02-while-loop", "01-if-else-chain"],
  catalogue: ["R1"],
  match,
  rewrite,
  check,
};
