import type { Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import type { RaiseSite } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/** Raises the structurer's labeled-nest encoding of a jump-table `switch`
 *  (catalogue rows 6, 7) back into a flat `switch` with real fall-through:
 *  the labels' tails move inside the arms and `SwitchArm.fallThrough` (F12)
 *  suppresses the emitter's appended `break;`. Only S1 (row 7's jump table,
 *  which `src/disasm` normalises across the v99 rename, hence `versions`
 *  unset) is implemented; S2 (row 6's `JStrictEqual` compare chain — fixtures
 *  09/10 at every corpus version) is blocked on F13 and matches nothing yet,
 *  so those two targets stay red by design (spec 10 §4). Fixture
 *  56-switch-string-jumptable needs no raise at all: its v98/v99 jump-table
 *  arms all `return`, so the structurer never builds a label nest.
 *  `after: ["loop-cond", "for-header"]` (ladder §2) and registered before
 *  `if-chain` so S2, when it lands, sees the compare spine intact. */
export const switchRaise: Pass<Stmt, RaiseSite> = {
  name: "switch-raise",
  stage: "A",
  targets: ["52-switch-jumptable", "53-switch-jumptable-large", "10-switch-no-fallthrough", "09-switch-fallthrough"],
  catalogue: [6, 7],
  after: ["loop-cond", "for-header"],
  match,
  rewrite,
  check,
};
