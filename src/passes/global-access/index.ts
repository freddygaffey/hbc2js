import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { GlobalAccessSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `"x" in r6` guard + `throw new ReferenceError(...)` + `r6.x` load ->
 *  a bare `x` — docs/LOWERING-CATALOGUE.md row R2. Stage B, after
 *  `expr-rebuild` (needs the member read `expr-rebuild` has already inlined
 *  into its consumer to locate it at all).
 *
 *  `before: ["call-shape"]` (docs/specs/passes/03-global-access.md §7) is
 *  deliberately **not** declared: `call-shape` is not implemented/registered
 *  yet (`docs/specs/passes/04-call-shape.md` is design-only), and
 *  `registry.ts`'s `enabledPasses` validates every `after`/`before` name
 *  against the *actual* registry, throwing `E_PASS_ORDER` for a dependency on
 *  a pass that exists nowhere in it. When `call-shape` lands, the ordering
 *  should be enforced from its own side (`after: ["global-access"]`), the
 *  same way every stage-B rung already gets `after: ["expr-rebuild"]`
 *  injected automatically rather than every earlier rung declaring
 *  `before: [later rung]`. */
export const globalAccess: Pass<readonly Stmt[], GlobalAccessSite> = {
  name: "global-access",
  stage: "B",
  targets: ["19-var-hoisting", "01-if-else-chain", "02-while-loop"],
  catalogue: ["R2"],
  after: ["expr-rebuild"],
  match,
  rewrite,
  check,
};
