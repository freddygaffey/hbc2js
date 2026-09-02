// default-params writer — docs/specs/passes/15-default-params.md §5, the
// idiom corrected per P-8 (see match.ts's header comment). `rewriteList`
// (match.ts) does the actual work so `check.ts` can call the identical
// pure builder (`buildFunc`) from `before` alone — the same discipline
// `expr-rebuild/check.ts` uses for its own `rewrite` reuse.
import type { Stmt } from "../ast.ts";
import type { DefaultParamsMatch } from "./match.ts";
import { rewriteList } from "./match.ts";

export function rewrite(m: DefaultParamsMatch): readonly Stmt[] {
  return rewriteList(m.root, m.data);
}
