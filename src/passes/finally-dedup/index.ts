import type { FinallyForm, Stmt } from "../../structure/ir.ts";
import type { Pass } from "../types.ts";
import { check } from "./check.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

/**
 * Stage A, annotation-only (docs/specs/passes/30-finally-dedup.md, design B;
 * 00-LADDER section 4.3's row is corrected to match), catalogue lowering row
 * 12: recognises the k + 1 copies `hermesc` makes of a source `finally` body
 * -- one per exit of the protected range plus one inside the synthesized
 * catch-and-rethrow handler -- and records, on the `try` node, which range the
 * printer should emit once as `finally { ... }` and which ranges it should
 * suppress. Nothing moves; `src/structure/verify.ts` never sees it.
 *
 * `before: ["loop-cond"]` is 00-LADDER section 4.2: fixture 16's duplicated
 * finalizer sits inside a loop whose tail guard `loop-cond` would otherwise
 * claim first. `try-shape` declares `after: ["finally-dedup"]` (spec 22
 * section 7), which this rung's registration finally makes expressible.
 */
export const finallyDedup: Pass<Stmt, FinallyForm> = {
  name: "finally-dedup",
  stage: "A",
  targets: ["12-try-catch-finally-return", "13-try-finally-no-catch", "16-finally-with-break-continue", "54-try-catch-finally-shared-range"],
  catalogue: [12],
  before: ["loop-cond"],
  match,
  rewrite,
  check,
};
