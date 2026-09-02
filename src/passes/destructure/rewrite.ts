// destructure writer — docs/specs/passes/16-destructure.md §5. `rewriteList`
// (match.ts) does the actual work so `check.ts` can call the identical pure
// builder from `before` alone, the same discipline `default-params/check.ts`
// uses for its own writer reuse.
import type { Stmt } from "../ast.ts";
import type { DestructureMatch } from "./match.ts";
import { rewriteList } from "./match.ts";

export function rewrite(m: DestructureMatch): readonly Stmt[] {
  return rewriteList(m.root, m.data);
}
