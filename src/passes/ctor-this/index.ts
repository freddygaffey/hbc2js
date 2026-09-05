import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { CtorThisGroup } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, readability row R12 (docs/specs/passes/26-ctor-this.md): inside a
 * recovered BASE `class`'s `constructor`, replace the `new.target.prototype`
 * + `Object.create(...)` stand-in object Hermes allocates for its own
 * receiver with the real `this`. Base-class [[Construct]] binds `this` to
 * exactly `OrdinaryCreateFromConstructor(new.target)` before the body runs,
 * and an explicit `return <that object>` is what `new` yields anyway, so the
 * substitution is observationally identical -- and it is what makes a native
 * private field foldable at all (`private-fields`' `isThisArg`: a `#name`
 * brands the object the class's own [[Construct]] created, never a
 * separately-allocated stand-in; docs/BUGS.md 2026-09-01 "class private
 * fields").
 *
 * **Ordering.** Between `class-recover` (which builds the `class` node this
 * rung reads) and `private-fields` (which needs the literal `this` this rung
 * produces), and before every renaming rung (P-21/D23: it follows register
 * identity, which `reg-split`'s per-store renaming would corrupt).
 *
 * **Versions.** 98 and 99, layout E -- the same gate `class-recover` uses;
 * there is no class to find a constructor in below that.
 */
export const ctorThis: Pass<readonly Stmt[], CtorThisGroup> = {
  name: "ctor-this",
  stage: "B",
  targets: ["34-class-static-members", "35-class-private-fields", "36-class-getters-setters"],
  catalogue: ["R12"],
  after: ["class-recover"],
  before: ["private-fields", "fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion, layoutClass) => hbcVersion >= 98 && layoutClass === "E",
  match,
  rewrite,
  check,
};
