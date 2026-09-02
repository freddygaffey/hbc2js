import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { OptionalChainSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * The labeled-block suffix run Hermes lowers `?.`/`?.()`/`?.[]`/`??` to
 * (docs/specs/passes/18-optional-chain.md, superseding the ladder's
 * `cond`-based one-liner per docs/PUSHBACK.md P-3) -> `?.` chains and `??`
 * fallbacks — docs/LOWERING-CATALOGUE.md row 25.
 *
 * `after: ["expr-rebuild", "global-access", "call-shape"]` (spec §7):
 * optional calls are shapes *of* a call, matched on the `Reflect.apply`
 * survivors `call-shape` leaves behind, and the guard/reset statements need
 * the same folding those three rungs already give every other stage-B
 * pass. `before: ["var-naming"]` — this rung's own `rX`/`rRes`/temp
 * registers must still read as bare `rN` names when it runs, and it wants
 * to delete the temps before `var-naming` picks new names for anything.
 */
export const optionalChain: Pass<readonly Stmt[], OptionalChainSite> = {
  name: "optional-chain",
  stage: "B",
  targets: ["48-optional-chaining-nullish"],
  catalogue: [25],
  after: ["expr-rebuild", "global-access", "call-shape"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
};
