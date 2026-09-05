import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { YieldSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** The v<=96 opcode-driven coroutine (`docs/LOWERING-CATALOGUE.md` row 17,
 *  `docs/lowering/generators.md`) collapsed back to the `function*` it was
 *  lowered from -- docs/specs/passes/25-yield-async-recovery.md.
 *
 *  **Stage B, not stage A** (spec §1.0, PUSHBACK P-24): the things the rewrite
 *  must delete -- `__hbc_makeGenerator(...)`, the `(__sent, __isReturn,
 *  __isThrow)` step closure, the `[value, __done]` tuple -- are produced by
 *  `src/emit/lower.ts`, are invisible to a stage-A matcher, and the rewrite is
 *  cross-function (one source `function*` is three emitted functions).
 *
 *  `versions: v <= 96` (§1.7): at v>=97 a generator is
 *  `__hbc_makeGeneratorLowered(<body>)` with no `__state`, no tuple and no
 *  `sameFrame` closure, which is `gen-lowered`'s (catalogue row 18) idiom.
 *
 *  Acyclic form only (§1.4, R-Y5): rebuilding a dispatcher whose suspend graph
 *  has a back edge is a structuring algorithm, not a matcher. Such a group is
 *  refused, never approximated.
 *
 *  `before: ["fn-naming", "reg-split", "var-naming"]` -- D23's structure-
 *  recovery block: this rung reads register identity (each arm's
 *  `<sentReg>`/`<retReg>`) and moves whole statement lists between functions,
 *  which is exactly what `reg-split`'s per-store renaming corrupts
 *  (docs/BUGS.md P-11b). */
export const yieldRecovery: Pass<readonly Stmt[], YieldSite> = {
  name: "yield-recovery",
  stage: "B",
  targets: ["23-generator-basic", "24-generator-return-throw", "25-generator-delegation", "26-infinite-generator-take", "27-async-await-basic", "28-async-await-error"],
  catalogue: [17],
  after: ["expr-rebuild", "global-access", "call-shape"],
  before: ["fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion) => hbcVersion <= 96,
  match,
  rewrite,
  check,
};
