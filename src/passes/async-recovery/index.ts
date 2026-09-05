import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { AsyncSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** The generator + builtin spawn-driver wrapper (`docs/LOWERING-CATALOGUE.md`
 *  row 19, `docs/lowering/async-await.md`) collapsed back to the `async
 *  function` it was lowered from -- docs/specs/passes/25-yield-async-recovery.md.
 *
 *  `versions` is unrestricted: the wrapper has one shape at all five versions
 *  (§1.6, and the driver is `__hbc_b_spawnAsync` at every one of them -- P-25).
 *  At v>=97 the generator it wraps is still `__hbc_makeGeneratorLowered`, so
 *  the rung takes refusal R-A4 there until `gen-lowered` (catalogue row 18)
 *  lands; that refusal is what makes registering this rung first safe, and is
 *  the point of the split.
 *
 *  `after: ["yield-recovery"]` is the ladder row's dependency minus
 *  `gen-lowered`, which cannot be named until it exists (`enabledPasses`
 *  throws `E_PASS_ORDER` for an unknown dependency -- spec §2). The landing
 *  commit for `gen-lowered` adds it. */
export const asyncRecovery: Pass<readonly Stmt[], AsyncSite> = {
  name: "async-recovery",
  stage: "B",
  targets: ["27-async-await-basic", "28-async-await-error"],
  catalogue: [19],
  after: ["expr-rebuild", "global-access", "call-shape", "yield-recovery"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
