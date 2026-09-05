import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { PrivateFieldsGroup } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, docs/BUGS.md 2026-09-01 row "class private fields" (bucket
 * `diff:GetOwnPrivateBySym/GetByVal`): `src/emit/lower.ts`'s "private names"
 * block lowers every private-name opcode into a computed-member/
 * `Object.defineProperty` shape (D-emit-first: behaviour-preserving before
 * any rung exists to recognise it). This rung runs immediately after
 * `class-recover` has raised the surrounding `CreateBaseClass`/
 * `CreateDerivedClass` group into a `class` node and folds that shape back
 * into real `#name` syntax wherever every reference to a given private name
 * is one of the four recognised shapes (docs/specs/passes/24-class-recover.md
 * is the class rung this depends on; see the LOWERING-CATALOGUE row this
 * lands with for why a private name is a separate rung rather than a
 * class-recover sub-form: a private name's own declare/access shapes are
 * independent of a class's member-install shapes and can be judged, and
 * refused, one name at a time).
 *
 * **Ordering.** Same slot as `class-recover` for the same reason (P-21/D23):
 * it also follows register identity (`foldInBody`'s alias fixed point) that
 * `reg-split`'s per-store renaming would corrupt, and it needs the `class`
 * node `class-recover` builds. `after: ["class-recover"]`; `before` every
 * renaming rung.
 *
 * **Versions.** 98 and 99, layout E -- the same gate `class-recover` uses;
 * there is nothing to fold where there is no class to fold it into.
 */
export const privateFields: Pass<readonly Stmt[], PrivateFieldsGroup> = {
  name: "private-fields",
  stage: "B",
  targets: ["35-class-private-fields"],
  catalogue: [20],
  after: ["class-recover", "ctor-this"],
  before: ["fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion, layoutClass) => hbcVersion >= 98 && layoutClass === "E",
  match,
  rewrite,
  check,
};
