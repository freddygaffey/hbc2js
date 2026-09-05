// §3.4 — the generator-shape checker. Neither this rung nor `async-recovery`
// can use `00-LADDER.md` §4.3's CF-preserving obligation (stage A only) or the
// expression-only one (both delete call effects), so the obligation is stated
// here (PUSHBACK P-26).
//
// Obligation 6, protocol identity, is the soundness argument and is stated
// rather than computed: `__hbc_makeGenerator`'s `resume(sent, isReturn,
// isThrow)` is called by `next(v)` as `(v, false, false)`, by `return(v)` as
// `(v, true, false)` and by `throw(e)` as `(e, false, true)`, which is exactly
// what a native `function*` does at a `yield`. `recover()`'s R-Y4 exists
// because the third of those -- "return completes at the yield, running
// enclosing finalizers" -- is not satisfiable while a finalizer body is
// duplicated into the forced-return arm.
import type { Stmt } from "../../emit/ast.ts";
import { freeNames, parses, walk } from "../ast.ts";
import type { CheckResult } from "../types.ts";
import { recover } from "./recover.ts";

const RESIDUE = ["__state", "__done", "__sent", "__isReturn", "__isThrow", "__this", "__args"];
const list = (x: unknown): readonly Stmt[] => (Array.isArray(x) ? (x as readonly Stmt[]) : [x as Stmt]);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function check(before: readonly Stmt[] | Stmt, after: readonly Stmt[] | Stmt): CheckResult {
  const b = list(before);
  const a = list(after);
  if (a.length !== b.length) return { ok: false, reason: "the rewrite changed the length of the statement list" };
  const changed = b.map((s, i) => (s === a[i] ? -1 : i)).filter((i) => i >= 0);
  if (changed.length !== 1) return { ok: false, reason: `the rewrite touched ${changed.length} statements; a generator group owns exactly one` };
  const i = changed[0]!;
  const stub = b[i]!;
  const got = a[i]!;
  // Obligation 5: re-derive the group from `before` by §3.1's rule alone and
  // require the very same result. An edit outside the declared group, a
  // mis-threaded arm or a reordered suspension all fail here, because the
  // yield sequence is a function of the suspend order and of nothing else.
  if (stub.k !== "func") return { ok: false, reason: "the replaced statement is not a function declaration, so no suspend/yield order can be re-derived from it" };
  const redone = recover(stub);
  if (!redone.ok) return { ok: false, reason: `no generator group to re-derive the yield order from (${redone.reason}: ${redone.detail}); the suspend order of \`before\` cannot be reproduced` };
  if (!same(redone.fn, got)) return { ok: false, reason: "the rewritten function is not the one §3.1/§3.3 derive from `before`: the suspend-to-yield order does not match" };
  // Obligation 5, second half: no protocol identifier survives, and the result
  // is real JavaScript.
  let residue: string | null = null;
  walk([got], { expr: (e) => { if (e.k === "ident" && RESIDUE.includes(e.name)) residue ??= e.name; } });
  if (residue !== null) return { ok: false, reason: `\`${residue}\` survives in the recovered generator` };
  if (!parses(a)) return { ok: false, reason: "the rewritten statement list is not syntactically valid JavaScript" };
  const bf = freeNames(b);
  for (const n of freeNames(a)) if (!bf.has(n)) return { ok: false, reason: `the rewrite introduced the free name \`${n}\`` };
  return { ok: true };
}
