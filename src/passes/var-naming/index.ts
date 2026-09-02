import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { RegisterSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Gives a surviving `rN` register a readable name invented from how it is
 *  used — never a recovered source name (there is none; a bare register
 *  carries no name in the bytecode) — docs/LOWERING-CATALOGUE.md row R5,
 *  docs/specs/passes/07-var-naming.md. Stage B, pure alpha-renaming, one
 *  register per driver iteration: no statement moves, no expression changes
 *  shape. The reuse gate (spec §4.1/§6) refuses any register whose defs span
 *  more than one recognised role — a wrong name is worse than a plain `rN`.
 *
 *  `after: ["expr-rebuild", "call-shape", "fn-naming"]` (spec §8): names are
 *  computed on the cleaned tree — registers `expr-rebuild` would fold must
 *  be gone first, `call-shape` must have turned a disguised call back into a
 *  real callee so heuristic #4 sees it, and `fn-naming`'s recovered names
 *  must already be in the `taken` set so a register can never collide with a
 *  real function name. `global-access` is injected into every stage-B rung's
 *  `after` automatically via `expr-rebuild` (`registry.ts`), so it is not
 *  repeated here. `var-naming` is last of D23's renaming block: `jsx-recover`
 *  runs *before* it now (it moved to the end of the structure-recovery
 *  block instead — `registry.ts`, docs/BUGS.md's 2026-09-02 P-11b row), so
 *  no forward `before: ["jsx-recover"]` is needed here any more. */
export const varNaming: Pass<readonly Stmt[], RegisterSite> = {
  name: "var-naming",
  stage: "B",
  targets: ["04-for-loop-basic", "22-nested-closures-counters", "43-template-literals", "02-while-loop"],
  catalogue: ["R5"],
  after: ["expr-rebuild", "call-shape", "fn-naming"],
  match,
  rewrite,
  check,
};
