import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ObjectLiteralSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * `NewObject`/`NewObjectWithBuffer` + a run of own-property defines back
 * into one object literal (docs/specs/passes/20-object-literal.md,
 * docs/LOWERING-CATALOGUE.md row 28) — `r3 = {}; r3.remove = f; r3.x = 1;`
 * becomes `r3 = {remove: f, x: 1}`.
 *
 * `after: ["expr-rebuild", "global-access", "call-shape"]` (spec §7): a
 * store's value is only an *expression* once `expr-rebuild` has inlined the
 * register that held it, and the two rungs that clean a call up have to
 * have run before a method value is worth putting in a literal.
 * `before: ["jsx-recover", "var-naming"]` — `jsx-recover` keys on the props
 * *object* of an element-creation call, which only exists once this rung has
 * rebuilt it, and the register this rung deletes must never have been named.
 */
export const objectLiteral: Pass<readonly Stmt[], ObjectLiteralSite> = {
  name: "object-literal",
  stage: "B",
  targets: ["63-object-literal"],
  catalogue: [28],
  after: ["expr-rebuild", "global-access", "call-shape"],
  before: ["jsx-recover", "var-naming"],
  match,
  rewrite,
  check,
};
