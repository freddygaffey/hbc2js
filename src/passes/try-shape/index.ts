import type { Stmt, TryShape } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage A, annotation-only (docs/specs/passes/22-try-shape-try-clean.md),
 * catalogue row 11: decides, from the structured function and its exception
 * regions, that a `try`'s `__pc` range guard is provably redundant and/or
 * its handler never reads the catch binding, and records that on the node.
 * `try-clean` (stage B) is what actually deletes the residue this leaves
 * behind.
 *
 * `after: ["finally-dedup"]` is spec 22 §7's declared ordering; it ships here
 * as of 2026-09-05, the commit that landed `finally-dedup`
 * (docs/specs/passes/30-finally-dedup.md).
 */
export const tryShape: Pass<Stmt, TryShape> = {
  name: "try-shape",
  stage: "A",
  targets: ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "15-catch-without-binding", "16-finally-with-break-continue"],
  catalogue: [11],
  after: ["finally-dedup"],
  before: ["label-clean"],
  match,
  rewrite,
  check,
};
