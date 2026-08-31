import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { TemplateLiteralSites } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `Reflect.apply(__hbc_HermesInternal.concat, "a", [x, "b"])` ->
 *  `` `a${x}b` `` and `rT = __hbc_b_getTemplateObject(id, dup, …); tag(rT,
 *  …subs)` -> `` tag`…` `` — docs/LOWERING-CATALOGUE.md row 21,
 *  docs/specs/passes/14-template-literal.md. Stage B, after `expr-rebuild`
 *  (argument arrays folded into literals, chunk registers inlined where
 *  possible) and `global-access`; before `var-naming` so it never burns a
 *  name on the `rT` register this rung deletes. Order-independent of
 *  `call-shape` (its R3a/R3b both refuse a concat site: `this` is a string
 *  literal, not `undefined`, and not the callee's own object) — asserted by
 *  negative unit tests in both rungs rather than an `after:` edge (spec §7). */
export const templateLiteral: Pass<readonly Stmt[], TemplateLiteralSites> = {
  name: "template-literal",
  stage: "B",
  targets: ["43-template-literals", "44-tagged-templates"],
  catalogue: [21],
  after: ["expr-rebuild", "global-access"],
  before: ["var-naming"],
  match,
  rewrite,
  check,
};
