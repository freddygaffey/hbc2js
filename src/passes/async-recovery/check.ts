// §3.4 — the same generator-shape obligation as `yield-recovery`, plus R-A5:
// this rung never turns a `yield` it did not account for into an `await`.
import type { Stmt } from "../ast.ts";
import { freeNames, parses, walk } from "../ast.ts";
import type { CheckResult } from "../types.ts";
import { recover } from "./recover.ts";

const list = (x: unknown): readonly Stmt[] => (Array.isArray(x) ? (x as readonly Stmt[]) : [x as Stmt]);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function check(before: readonly Stmt[] | Stmt, after: readonly Stmt[] | Stmt): CheckResult {
  const b = list(before);
  const a = list(after);
  if (a.length !== b.length) return { ok: false, reason: "the rewrite changed the length of the statement list" };
  const changed = b.map((s, i) => (s === a[i] ? -1 : i)).filter((i) => i >= 0);
  if (changed.length !== 1) return { ok: false, reason: `the rewrite touched ${changed.length} statements; an async group owns exactly one` };
  const i = changed[0]!;
  const got = a[i]!;
  // R-A5, checked before anything else: an `await` may only stand where this
  // rung's own re-derivation puts one, and no `yield` may survive in the body
  // it produced. A `yield` in `after` that the rung did not produce means the
  // group was not the one §3.1 describes.
  let strayYield = false;
  walk([got], { expr: (e) => { if (e.k === "yield") strayYield = true; } });
  const stub = b[i]!;
  if (stub.k !== "func") return { ok: false, reason: "the replaced statement is not a function declaration, so no yield-to-await mapping can be re-derived" };
  const redone = recover(stub);
  if (!redone.ok) return { ok: false, reason: `no async group to re-derive from (${redone.reason}: ${redone.detail}); every recovered yield must have become an await` };
  if (strayYield) return { ok: false, reason: "the rewritten function carries a `yield` this rung did not produce, so it cannot be turned into an await (R-A5)" };
  if (!same(redone.fn, got)) return { ok: false, reason: "the rewritten function is not the one §3.1/§3.3 derive from `before`: the await order does not match the suspend order" };
  if (!parses(a)) return { ok: false, reason: "the rewritten statement list is not syntactically valid JavaScript" };
  const bf = freeNames(b);
  for (const n of freeNames(a)) if (!bf.has(n)) return { ok: false, reason: `the rewrite introduced the free name \`${n}\`` };
  return { ok: true };
}
