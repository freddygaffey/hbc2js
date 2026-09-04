// jsx-recover checker — docs/specs/passes/08-jsx-recovery.md §6: offline,
// structural, no runtime. Three obligations:
//
//   1. `after` is byte-identical to the fold `deriveSites` recomputes from
//      `before` alone (the guards in match.ts — clean span, dead-after,
//      moved-impure, input-clobbered, reads-absorbed, in-try — are all re-run
//      by that call; nothing `match` recorded is trusted).
//   2. The inverse: for every site, `jsxToCall(node)` is structurally the
//      exact call it replaced (§6's bijection). For a site that absorbed
//      nothing this *is* the site's whole proof; for one that absorbed
//      definitions, the call it reproduces is the one whose operands are
//      those definitions' values in place — which is what the guards prove
//      evaluates the same effects in the same order as the statements they
//      came from.
//   3. (formerly) `parses(after)` — deliberately removed: the stage-B driver
//      already runs `parses` once per (pass, function) on the whole
//      reconstructed body (`src/passes/README.md`), so a per-site call here
//      both costs a whole-list print+parse on every site of a real bundle
//      and spuriously refuses one whose enclosing list holds an untouched
//      bare `break`/`continue` (legal in the real function, illegal the
//      moment this list alone is wrapped standalone — object-literal/
//      check.ts, commit 3b0ec3a, docs/BUGS.md `stage-b-per-site-parses`).
//
// `expressionOnlyCheck` is deliberately not used: absorbing `rP = {}; rP.k =
// v` removes fresh-object `member-write` entries from the effect sequence by
// design (unobservable — no setter can exist on a literal `{}`). The
// obligations above are the precise replacement.
import type { Stmt } from "../ast.ts";
import { jsxToCall } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { deriveSites } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const derived = deriveSites(before, ctx.fnBody ?? before);
  if (derived.sites.length === 0) return { ok: false, reason: "no jsx site in before" };
  const absorbed = new Set<number>();
  for (const s of derived.sites) for (const k of s.absorbed) absorbed.add(k);
  if (after.length !== before.length - absorbed.size) return { ok: false, reason: `unexpected shape: expected ${before.length - absorbed.size} statements after, got ${after.length}` };
  if (JSON.stringify(after) !== JSON.stringify(derived.after)) return { ok: false, reason: "the rewrite is not exactly the derived fold of the matched sites" };
  for (const s of derived.sites) {
    if (JSON.stringify(jsxToCall(s.node)) !== JSON.stringify(s.resolved)) return { ok: false, reason: "inverse mismatch: jsxToCall(node) is not the call it replaced" };
    // `resolved` may differ from the call only in the operands the site absorbed.
    const c = s.call as Extract<typeof s.call, { k: "call" }>;
    const r = s.resolved as Extract<typeof s.resolved, { k: "call" }>;
    if (c.k !== "call" || r.k !== "call" || c.callee !== r.callee || c.args.length !== r.args.length) return { ok: false, reason: "resolved call shape mismatch" };
    for (let k = 0; k < c.args.length; k++) {
      if (c.args[k] === r.args[k]) continue;
      if (k > 1 || c.args[k]!.k !== "ident" || s.absorbed.length === 0) return { ok: false, reason: "resolved call substitutes an operand the site did not absorb" };
    }
  }
  return { ok: true };
}
