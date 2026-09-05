// try-shape writer — spec 22 §5. Pure annotation: `body` and `handler` come
// out `===`-identical, nothing else in the tree changes.
import type { Stmt } from "../../structure/ir.ts";
import type { TryShape } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import type { TryNode } from "./match.ts";

export function rewrite(m: Match<Stmt, TryShape>, _ctx: PassContext): Stmt {
  const node = m.nodes[0]! as TryNode;
  return { ...node, shape: m.data };
}
