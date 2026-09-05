import type { Stmt } from "../ast.ts";
import type { YieldSite } from "../tree.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `yield-loop` -- the CYCLIC v<=96 opcode-driven coroutine: a generator whose
 *  suspend graph has a BACK EDGE, which `yield-recovery` refuses as R-Y5
 *  `cyclic-dispatch` (docs/specs/passes/25-yield-async-recovery.md section 1.4
 *  and section 6.2). Spec: docs/specs/passes/29-yield-loop.md; catalogue R15.
 *
 *  The structurer lays the step closure out as a chain of nested labelled
 *  blocks, so the suspend graph's segments are the label TAILS and its edges
 *  are the labelled `break`s. Threading an arm into a tail strands a `break L`
 *  outside `L: { ... }`, and that stranded break IS the back edge;
 *  `restructureSegments` (spec 25's F25-4, `src/passes/restructure.ts`, reached
 *  through `../tree.ts`) closes it as `L: while (true) { ... break; }` with the
 *  edge spelled `continue L`.
 *
 *  Site rule, writer and generator-shape checker are spec 25's, shared through
 *  the framework's `makeMatch`/`makeCheck`; only `RecoverOptions.loops`
 *  differs, so the two rungs cannot drift apart.
 *
 *  `versions: v <= 96` (spec 25 section 1.7): at v>=97 a generator is
 *  `__hbc_makeGeneratorLowered(<body>)`, which is `gen-lowered`'s idiom
 *  (catalogue row 18), not this one.
 *
 *  `after: ["yield-recovery"]` -- a group the acyclic rung already recovered
 *  carries `generator: true` and is answered `no-generator-site` before
 *  anything else is read, so the two never compete for a site.
 *  `before: ["fn-naming", "reg-split", "var-naming"]` -- D23's structure-
 *  recovery block, exactly as `yield-recovery`: this rung reads register
 *  identity and moves whole statement lists between functions. */
export const yieldLoop: Pass<readonly Stmt[], YieldSite> = {
  name: "yield-loop",
  stage: "B",
  targets: ["23-generator-basic", "26-infinite-generator-take"],
  catalogue: ["R15"],
  after: ["expr-rebuild", "global-access", "call-shape", "yield-recovery"],
  before: ["async-recovery", "fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion) => hbcVersion <= 96,
  match,
  rewrite,
  check,
};
