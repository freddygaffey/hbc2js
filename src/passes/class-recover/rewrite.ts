// class-recover writer -- spec 24 section 3.3. The class node is built from
// the matcher's group and nothing else; every method body, computed key and
// the super value are carried over `===`-identical, never rebuilt, which is
// what lets the checker compare by identity.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { ClassGroup } from "./match.ts";
import { buildAfter } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], ClassGroup>, _ctx: PassContext): readonly Stmt[] {
  return buildAfter(m.nodes[0]!, m.data);
}
