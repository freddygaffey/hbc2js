import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ChainSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Flattens the `if`/`else` staircase (catalogue row 1): drops an `else`
 *  whose `then` arm always completes abruptly (C1, the early-return form)
 *  and marks a surviving `else { if … }` chain link with `elseIf` so the
 *  printer can render `else if` (C3). Row 1 is the corpus's one idiom with
 *  zero version sensitivity, so `versions` is unset — this rung runs
 *  everywhere. `after: ["loop-cond", "for-header"]` (ladder §2): a guard
 *  `if` inside an unformed loop is the loop's test, and flattening its
 *  `else` before `loop-cond` has annotated it would hide the tail-guard
 *  shape `loop-cond` keys on. */
export const ifChain: Pass<Stmt, ChainSite> = {
  name: "if-chain",
  stage: "A",
  targets: ["01-if-else-chain", "09-switch-fallthrough", "10-switch-no-fallthrough"],
  catalogue: [1],
  after: ["loop-cond", "for-header"],
  match,
  rewrite,
  check,
};
