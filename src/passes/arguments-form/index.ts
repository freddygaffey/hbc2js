import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ArgumentsFormSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * The emitter's `__hbc_arguments(arguments)` reification call
 * (`src/emit/lower.ts:809`, spec 23 section 1.1) back to a bare `arguments`
 * wherever no parameter slot can alias it -- docs/LOWERING-CATALOGUE.md row
 * R10. Also fixes docs/BUGS.md's `arguments-identity` row: two `Reify*` in
 * one function used to print two distinct fresh objects; both now read the
 * same bare `arguments`.
 *
 * `after: ["expr-rebuild", "spread-rest"]` (spec 23 section 2): the folded
 * expression is what both matchers need (an un-rebuilt reify call is split
 * over several register stores), and `spread-rest` is load-bearing --
 * `combine(a1, ...rest)`'s rest parameter (`CopyRestArgs`) is exactly what
 * makes that function's `arguments` unmapped, and this rung must see the
 * rest parameter already recovered to accept the site.
 */
export const argumentsForm: Pass<readonly Stmt[], ArgumentsFormSite> = {
  name: "arguments-form",
  stage: "B",
  targets: ["49-arguments-object", "42-rest-params"],
  catalogue: ["R10"],
  after: ["expr-rebuild", "spread-rest"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match,
  rewrite,
  check,
};
