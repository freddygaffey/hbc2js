// super-call writer -- the tree is built purely from `before` (`foldAll` is a
// pure function of it), the discipline `class-recover`/`ctor-this` follow,
// which is what lets the checker re-derive it.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { SuperCallGroup } from "./match.ts";
import { foldAll } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], SuperCallGroup>, _ctx: PassContext): readonly Stmt[] {
  return foldAll(m.nodes[0]!).after;
}
