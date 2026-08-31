// switch-raise writer — spec 10 §5.
//
// Purely assembles what the matcher planned: the core's `block bX` (when
// present) followed by the same `switch` node with the reordered, tail-
// absorbing arm list. Every `labeled` wrapper and every `break Lk` the plan
// authorised is gone; every other statement object is carried by identity, in
// the plan's order — the checker re-derives the plan from `before` and walks
// every arm's path, so a disagreement between this writer and the matcher is
// caught, not trusted.
import { seq } from "../../structure/ir.ts";
import type { Stmt, SwitchArm } from "../../structure/ir.ts";
import type { RaiseMatch } from "./match.ts";

export function rewrite(m: RaiseMatch): Stmt {
  const { peeled, newCases, newDefault } = m.data;
  const sw = peeled.sw;
  const cases: SwitchArm[] = newCases.map((a) => ({ value: a.value, isString: a.isString, body: seq([...a.body]), ...(a.fallThrough ? { fallThrough: true as const } : {}) }));
  return seq([...peeled.core.slice(0, -1), { ...sw, cases, default: seq([...newDefault]) }]);
}
