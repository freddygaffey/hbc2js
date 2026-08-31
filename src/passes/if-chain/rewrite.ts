// if-chain writer — spec 09 §5.
//
// C1: the `if` keeps its `cfgBlock` and its `then` arm byte-for-byte; its
// `else` becomes the canonical empty seq (which the printer renders as no
// `else` at all), and the old `else` items become the `if`'s following
// siblings, in order, in one flat `seq`. Nothing is deleted, duplicated or
// reordered. Emitting the canonical empty seq directly is what lets the
// spec's optional C2 hygiene rule be dropped, as it recommends.
//
// C3: annotation only — the tree is otherwise untouched, so the driver's
// round-trip proves nothing for it and check.ts §6.4 is its whole guard.
import { EMPTY, seq } from "../../structure/ir.ts";
import type { Stmt } from "../../structure/ir.ts";
import type { ChainMatch, IfNode } from "./match.ts";

export function rewrite(m: ChainMatch): Stmt {
  const node = m.root as IfNode;
  if (m.data.rule === "C3") return { ...node, elseIf: true };
  return seq([{ ...node, else: EMPTY }, ...m.data.elseItems]);
}
