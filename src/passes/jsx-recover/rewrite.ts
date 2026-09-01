// jsx-recover writer — docs/specs/passes/08-jsx-recovery.md §5.
//
// The whole rewrite is computed by `deriveSites` (match.ts) as a fold over the
// list — each site replaces exactly one `call` node (by identity) with a
// `jsx` node whose parts are the call's own sub-expressions by reference (or
// the absorbed definitions' values, likewise by reference) and deletes the
// statements it absorbed. `rewrite` therefore just hands back the folded list;
// `check.ts` recomputes it from `before` alone and compares.
import type { Stmt } from "../ast.ts";
import type { JsxMatch } from "./match.ts";

export function rewrite(m: JsxMatch): readonly Stmt[] {
  return m.data.after;
}
