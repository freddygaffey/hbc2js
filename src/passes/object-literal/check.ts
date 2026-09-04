// object-literal checker — docs/specs/passes/20-object-literal.md §6.
//
// Recompute-and-diff (the `optional-chain`/`spread-rest` pattern): nothing
// here trusts the driver's captured match data. The site is re-derived from
// `before` alone by re-running the real matcher, and the written literal is
// compared property by property against that re-derivation — so a writer
// that dropped a property, reordered two, or folded one statement too many
// is rejected even though the driver handed it a match saying otherwise.
import type { Expr, Stmt } from "../ast.ts";
import { identUses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { match } from "./match.ts";

function sameExpr(a: Expr, b: Expr): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const rescan = match(before, ctx);
  if (rescan === null) return { ok: false, reason: "no object-literal site recomputed from before" };
  const site = rescan.data;

  if (after.length !== before.length - site.storeCount) return { ok: false, reason: "object-literal did not remove exactly the folded stores" };
  for (let i = 0; i < site.defIndex; i++) {
    if (before[i] !== after[i]) return { ok: false, reason: "object-literal changed a statement before the definition" };
  }
  for (let i = site.defIndex + 1; i < after.length; i++) {
    if (after[i] !== before[i + site.storeCount]) return { ok: false, reason: "object-literal changed a statement after the folded run" };
  }

  const repl = after[site.defIndex];
  if (repl === undefined || repl.k !== "expr" || repl.expr.k !== "assign" || repl.expr.target.k !== "ident" || repl.expr.target.name !== site.reg) {
    return { ok: false, reason: "object-literal replacement is not `rN = <object>`" };
  }
  const value = repl.expr.value;
  if (value.k !== "object") return { ok: false, reason: "object-literal replacement value is not an object literal" };
  if (value.props.length !== site.props.length) return { ok: false, reason: "object-literal property count differs from the recomputed site" };
  for (let i = 0; i < value.props.length; i++) {
    const got = value.props[i]!;
    const want = site.props[i]!;
    if ("k" in got) return { ok: false, reason: "object-literal wrote a spread property" };
    if (got.key !== want.key || got.computed !== want.computed) return { ok: false, reason: "object-literal property key/order differs from the recomputed site" };
    if (!sameExpr(got.value, want.value)) return { ok: false, reason: "object-literal property value is not the store's own value expression" };
  }
  // Belt and braces on §4 precondition 6, restated on the *written* tree: no
  // property value may read or write the register the literal is assigned to.
  // (`parses` is deliberately NOT called here: the stage-B driver already
  // runs it once per (pass, function) — `src/passes/README.md` — and doing it
  // per site costs a whole-function print+parse on every one of the ~1300
  // sites a real bundle has, which is what `pipeline-speed.test.ts`'s P-1
  // ceiling is there to stop.)
  const written = value.props.filter((p): p is Extract<typeof p, { key: string }> => !("k" in p)).map((p): Stmt => ({ k: "expr", expr: p.value }));
  const u = identUses(written, site.reg);
  if (u.reads + u.writes > 0) return { ok: false, reason: "object-literal property value reads the object being built" };
  void ctx;
  return { ok: true };
}
