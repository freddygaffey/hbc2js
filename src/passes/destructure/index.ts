import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { DestructureSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** The per-element iterator-protocol block run (array pattern) / `GetById`
 *  fan-out (object pattern) -> a destructuring assignment —
 *  docs/LOWERING-CATALOGUE.md row 22, docs/specs/passes/16-destructure.md.
 *
 *  `after: [...]` per spec §7: needs the loads/guards `expr-rebuild` folds,
 *  `global-access`'s member-read shape, `call-shape`'s call shape, and any
 *  `= {}`/`= []` outer parameter default `default-params` already promoted
 *  (where it fired — §8 Q2 covers where it didn't; this rung's object rule
 *  keys on the observed source register regardless). `before: ["var-naming"]`
 *  (spec's own `before` also names `spread-rest`, not yet registered). */
export const destructure: Pass<readonly Stmt[], DestructureSite> = {
  name: "destructure",
  stage: "B",
  targets: ["37-destructuring-array", "38-destructuring-object", "39-destructuring-params"],
  catalogue: [22],
  after: ["expr-rebuild", "global-access", "call-shape", "default-params"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
};
