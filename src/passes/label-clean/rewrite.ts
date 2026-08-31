// label-clean writer — docs/specs/passes/06-label-clean.md §5. Builds only
// the shape `match` captured; L1 and L2 share one implementation because L1
// is exactly L2 with zero matching breaks (`deleteTailBreaks` is a no-op and
// returns `node.body` unchanged by reference in that case).
import type { Stmt } from "../../structure/ir.ts";
import { deleteTailBreaks } from "./match.ts";
import type { LabelMatch } from "./match.ts";

export function rewrite(m: LabelMatch): Stmt {
  const { data } = m;
  switch (data.rule) {
    case "L1":
    case "L2":
      return deleteTailBreaks(data.node.body, data.node.label);
    case "L3":
      return { ...data.node, hideLabel: true };
    case "L4":
      return data.node.body[0]!;
  }
}
