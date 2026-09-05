// private-fields writer -- the tree is built purely from `before` (the
// matcher's own `foldAll` is a pure function of it), same discipline
// class-recover's writer follows for its group.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { PrivateFieldsGroup } from "./match.ts";
import { foldAll } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], PrivateFieldsGroup>, _ctx: PassContext): readonly Stmt[] {
  return foldAll(m.nodes[0]!).after;
}
