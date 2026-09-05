// finally-dedup writer -- docs/specs/passes/30-finally-dedup.md section 4.
// Pure annotation: `body` and `handler` come out `===`-identical.
import type { FinallyForm, Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import type { TryNode } from "./match.ts";

export function rewrite(m: Match<Stmt, FinallyForm>, _ctx: PassContext): Stmt {
  const node = m.nodes[0]! as TryNode;
  return { ...node, finalizer: m.data };
}
