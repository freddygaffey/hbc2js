import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { ClassGroup } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, catalogue row 20 (docs/specs/passes/24-class-recover.md): raises a
 * `CreateBaseClass`/`CreateDerivedClass` group -- the constructor binding, the
 * derived form's `Object.setPrototypeOf` pair and every
 * `Object.defineProperty` on the group's constructor or prototype value --
 * back into a `class` head with its members in install order. Sub-forms C1-C4;
 * C5 (constructor + instance fields) and `super` recovery are separate rungs
 * (spec 24 sections 1.6 and 6.5, refusals R-C8/R-C9).
 *
 * **Ordering (P-21, D23).** Structure-recovery block, before the renaming
 * block: this rung reads register identity twice over (it follows the
 * class-creation destination registers through `Object.defineProperty`
 * targets, and resolves a register-held method key), which `reg-split`'s
 * per-store renaming is exactly the corruption D23 exists to prevent. That
 * contradicts `00-LADDER.md`'s old `after: [fn-naming]` row, which predates
 * D23; the row and `fn-naming/index.ts`'s comment are corrected with this
 * landing.
 *
 * **Versions (P-22).** 98 and 99, layout E: all five class fixtures have both
 * builds committed and they lower identically (spec 24 section 1.0). What is
 * absent at <= 96 is the compiler, not the shape -- v84/v94/v96 `hermesc` has
 * no class lowering in IRGen at all.
 */
export const classRecover: Pass<readonly Stmt[], ClassGroup> = {
  name: "class-recover",
  stage: "B",
  targets: ["32-class-basic", "33-class-inheritance-super", "34-class-static-members", "35-class-private-fields", "36-class-getters-setters", "67-class-static-and-new"],
  catalogue: [20],
  after: ["expr-rebuild", "global-access", "call-shape", "object-literal"],
  before: ["fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion, layoutClass) => hbcVersion >= 98 && layoutClass === "E",
  match,
  rewrite,
  check,
};
