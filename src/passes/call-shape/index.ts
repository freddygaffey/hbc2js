import type { Stmt } from "../ast.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { CallShapeSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** `Reflect.apply(f, this, [a, b])` / `Reflect.construct(C, [a, b])` /
 *  `__hbc_b_functionPrototypeCall`/`Apply` -> `f(a, b)` / `o.m(a, b)` /
 *  `new C(a, b)` / `f.call(t, a)` / `f.apply(t, arr)` —
 *  docs/LOWERING-CATALOGUE.md row R3. Stage B, after `expr-rebuild` (needs
 *  the argument array already folded into a literal — dynamic-args would
 *  otherwise refuse every site) and `global-access` (docs/specs/passes/
 *  03-global-access.md §7: it needs the member read `expr-rebuild` inlines
 *  to still be a direct `G.p` load, which would be gone if `call-shape` ran
 *  first and turned a call's own such load into part of a rewritten callee
 *  expression it does not look inside the same way).
 *
 *  `before: ["spread-rest", "optional-chain", "class-recover"]` (spec 04 §7)
 *  is deliberately **not** declared, the same reason `global-access/index.ts`
 *  omits its own forward-looking `before`: none of those three rungs are
 *  registered yet, and `registry.ts`'s `enabledPasses` validates every
 *  `after`/`before` name against the *actual* registry, throwing
 *  `E_PASS_ORDER` for a dependency on a pass that exists nowhere in it. When
 *  any of them lands, the ordering should be enforced from its own side
 *  (`after: ["call-shape"]`). */
export const callShape: Pass<readonly Stmt[], CallShapeSite> = {
  name: "call-shape",
  stage: "B",
  targets: ["19-var-hoisting", "01-if-else-chain", "32-class-basic", "21-iife-closures"],
  catalogue: ["R3"],
  after: ["expr-rebuild", "global-access"],
  match,
  rewrite,
  check,
};
