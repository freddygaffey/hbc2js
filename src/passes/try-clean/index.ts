import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import type { Analysis } from "./analysis.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, expression-only deleting rung (docs/specs/passes/
 * 22-try-shape-try-clean.md), catalogue rows 11/12: deletes the `__pc`/
 * `__exc` scaffolding no surviving guard or read needs — stores, copies,
 * both frames, and an unread catch binding. Never removes a `try`, a
 * `catch` body or a `throw`; correct with `try-shape` skipped (it re-derives
 * liveness from the AST it is given, spec 22 §7).
 *
 * `after: ["expr-rebuild"]` (PL-11 injects this into every stage-B rung
 * anyway); registered in the structure-recovery block (D23), immediately
 * after `object-literal` and before the renaming rungs (`before`) so a
 * register this rung's deletions expose as dead never gets named first.
 */
export const tryClean: Pass<readonly Stmt[], Analysis> = {
  name: "try-clean",
  stage: "B",
  targets: ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "15-catch-without-binding", "16-finally-with-break-continue"],
  catalogue: [11, 12],
  after: ["expr-rebuild"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
