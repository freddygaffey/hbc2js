// globalthis-dead-store checker. Trusts nothing the `Match` was handed:
// `match` is re-run on `before`, and every obligation below is checked
// against that fresh re-derivation (the ladder's standing discipline —
// see `try-clean/check.ts`, the same "whole-function one-shot delete"
// shape).
import { freeNames, parses } from "../ast.ts";
import type { Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { applyAnalysis } from "./analysis.ts";
import { match } from "./match.ts";

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "globalthis-dead-store has no matching site to re-derive the deletions from" };
  const a = m.data;

  // 1. Undo by re-insertion: re-applying the freshly re-derived deletions to
  // `before` must reproduce `after` exactly — a deleting rung's analogue of
  // a byte-identical undo. Any edit beyond the declared deletions fails
  // here.
  const declared = applyAnalysis(before, a);
  if (!deepEqual(declared, after)) return { ok: false, reason: "globalthis-dead-store's result is not exactly the declared deletions applied to `before`" };

  if (!parses(after)) return { ok: false, reason: "globalthis-dead-store result does not parse" };

  // The soundness argument for *which* stores are safe to delete lives in
  // `analyze`'s own `isDeadLocally` scan, re-derived independently above
  // from `before` (not trusted from `m.data`) — obligation 1 already
  // requires `after` to be exactly its output. A whole-function "does
  // `reg` have any read left" recheck here would be *wrong*, not merely
  // redundant: `reg` can legitimately still read in `after` through its
  // other, unrelated write of the same reused register (rn-template's
  // `r0 = globalThis; r0 = console.warn(…); return r0;` — the surviving
  // `return r0` reads the second write, not the deleted one).

  // 2. No new free name: a deletion can only shrink what a function
  // references, never grow it.
  const freeBefore = freeNames(before);
  for (const n of freeNames(after)) if (!freeBefore.has(n)) return { ok: false, reason: `globalthis-dead-store introduced a new free name: ${n}` };

  return { ok: true };
}
