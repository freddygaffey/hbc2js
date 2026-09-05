// globalthis-dead-store writer. A filter, never a rebuild of an unrelated
// node: statement order, statement identity and every other field survive
// untouched outside the declared deletions.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { applyAnalysis } from "./analysis.ts";
import type { Analysis } from "./analysis.ts";

export function rewrite(m: Match<readonly Stmt[], Analysis>, _ctx: PassContext): readonly Stmt[] {
  return applyAnalysis(m.nodes[0]!, m.data);
}
