import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { SuperCallGroup } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage B, readability row R14 (docs/specs/passes/28-super-call.md): inside a
 * recovered DERIVED `class`'s `constructor`, rebuild Hermes's
 * `Reflect.construct(Object.getPrototypeOf(<the class>), [args], new.target)`
 * lowering back into `super(args)`, and give the stand-in register the name
 * the language gives it -- `this`. Sound because ES2024 13.3.7.1 defines
 * SuperCall as exactly Construct(activeFunction.[[GetPrototypeOf]](), args,
 * newTarget) followed by binding the result to `this`; the matcher's job is to
 * prove the three operands are the constructor's own (R-SC1) and that the one
 * call dominates every later use of the stand-in (R-SC2..R-SC5).
 *
 * **Ordering.** After `class-recover` (which builds the `class` node, and
 * whose enclosing function body carries the `_eD_S = <class>` store this rung
 * needs for R-SC1) and before `ctor-this`, which refuses a derived class
 * outright (R-CT1) and is unaffected by the rebuilt shape -- a derived
 * constructor never allocates a `new.target.prototype` stand-in, so
 * `ctor-this` sees no site here either before or after this rung. It is also
 * before every renaming rung (P-21/D23: it follows register identity, which
 * `reg-split`'s per-store renaming would corrupt).
 *
 * **Versions.** 98 and 99, layout E -- the same gate `class-recover` uses.
 */
export const superCall: Pass<readonly Stmt[], SuperCallGroup> = {
  name: "super-call",
  stage: "B",
  targets: ["33-class-inheritance-super"],
  catalogue: ["R14"],
  after: ["class-recover"],
  before: ["ctor-this", "private-fields", "fn-naming", "reg-split", "var-naming"],
  versions: (hbcVersion, layoutClass) => hbcVersion >= 98 && layoutClass === "E",
  match,
  rewrite,
  check,
};
