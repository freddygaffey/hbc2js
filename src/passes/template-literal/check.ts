// template-literal checker — docs/specs/passes/14-template-literal.md §6.
//
// Deviation from §6 item 1's literal `expressionOnlyCheck(before, after)`,
// recorded here and in docs/AGENT-LOG.md, for the same reason
// `call-shape/check.ts` records its own: `effectSequence` is a byte-for-byte
// comparison, and this rewrite *removes* effect entries by design — T1 drops
// the `member-read`s of `Reflect.apply`/`__hbc_HermesInternal.concat` and
// the `(member.apply, 3)` call record (the template's ToString of each
// substitution is what that builtin did; F14 records the template as its
// substitutions in order), T2 drops statement `A`'s `getTemplateObject`
// call record (the engine's per-site template object replaces it). A literal
// sequence diff therefore refuses every correct site. What D14 actually
// needs — no substitution reordered, duplicated, dropped or rebuilt; nothing
// else in the list touched — is checked directly: the sites are re-derived
// from `before` alone (`deriveSites` never sees `match`'s data), `after` must
// be byte-identical to `applySites(before, sites)` — the same pure builder
// `rewrite.ts` uses, which reuses every substitution node by reference and
// every untouched statement by identity — and each replacement is
// re-validated: the chunk resolutions, the cooking of every quasi against
// its cooked value (T1: `cook(escapeForTemplate(chunk)) === chunk`; T2:
// `cook(raw[i]) === cooked[i]`), and a parse of the printed node.
import type { Stmt } from "../ast.ts";
import { parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { cook, deriveSites, escapeForTemplate } from "./match.ts";
import { applySites, replacementFor } from "./rewrite.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const fnBody = ctx.fnBody ?? before;
  const { sites } = deriveSites(before, fnBody);
  if (sites.length === 0) return { ok: false, reason: "no template-literal site in before" };

  const t2Count = sites.filter((s) => s.kind === "t2").length;
  if (after.length !== before.length - t2Count) return { ok: false, reason: `unexpected shape: expected ${before.length - t2Count} statements after, got ${after.length}` };

  const expected = applySites(before, sites);
  for (let i = 0; i < expected.length; i++) {
    if (!sameStmt(expected[i]!, after[i]!)) return { ok: false, reason: "the rewrite is not exactly the derived replacement of the matched sites" };
  }

  for (const site of sites) {
    const node = replacementFor(site);
    if (site.kind === "t1") {
      if (node.k !== "template" || node.quasis.length !== site.chunks.length || node.exprs.length !== site.subs.length) return { ok: false, reason: "T1 chunk/substitution count mismatch" };
      if (node.quasis.length !== node.exprs.length + 1) return { ok: false, reason: "template invariant quasis.length === exprs.length + 1 broken" };
      if (!node.exprs.every((e, i) => e === site.subs[i])) return { ok: false, reason: "T1 substitution was rebuilt, not reused" };
      for (let i = 0; i < site.chunks.length; i++) {
        if (cook(escapeForTemplate(site.chunks[i]!)) !== site.chunks[i]) return { ok: false, reason: "T1 chunk does not survive escape/cook round-trip" };
      }
    } else {
      if (node.k !== "tagged" || node.quasi.k !== "template") return { ok: false, reason: "T2 replacement is not a tagged template" };
      if (node.quasi.quasis.length !== site.subs.length + 1) return { ok: false, reason: "T2 arity-mismatch" };
      if (!node.quasi.exprs.every((e, i) => e === site.subs[i])) return { ok: false, reason: "T2 substitution was rebuilt, not reused" };
      for (let i = 0; i < site.raw.length; i++) {
        if (cook(site.raw[i]!) !== site.cooked[i]) return { ok: false, reason: "T2 raw-does-not-cook" };
      }
    }
    if (!parses([{ k: "expr", expr: node }])) return { ok: false, reason: "the printed template does not parse" };
  }
  return { ok: true };
}
