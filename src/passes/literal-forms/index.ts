// literal-forms -- docs/LOWERING-CATALOGUE.md rows 29 (regex, L-R) and 30
// (TypeOfIs masks, L-T). Both sub-forms are local expression rewrites
// (`match.ts`/`rewrite.ts` operate at `Expr` granularity); this file wraps
// them into the `Stmt[]`-granular `Pass` the stage-B driver expects, exactly
// as `docs/specs/passes/23-arguments-form-literal-forms.md` section 3.2
// describes: "the ordinary per-node site (post-order, innermost first)".
//
// Finding a site with `walk` (which does cross into a nested `k:"func"`
// body) is sound here even though `stmtLists`/`applyAstPasses` treat a
// nested function's body as a separate site: `emitOne` processes functions
// child-first (F1's own doc comment on `stmtLists`), so by the time this
// function's own body is scanned, any nested closure embedded in it has
// already reached literal-forms's fixed point -- there is nothing left to
// find there, so crossing the boundary costs a little redundant walking and
// changes no outcome.
import type { Expr, Stmt } from "../ast.ts";
import { mapStmts, walk } from "../ast.ts";
import type { CheckResult, Match, Pass, PassContext } from "../types.ts";
import { check } from "./check.ts";
import { match as matchExpr } from "./match.ts";
import type { LiteralFormsMatch } from "./match.ts";
import { rewriteExpr } from "./rewrite.ts";

interface Site {
  readonly expr: Expr;
  readonly inner: LiteralFormsMatch;
}

function findSite(list: readonly Stmt[], ctx: PassContext): Site | null {
  let found: Site | null = null;
  walk(list, {
    expr: (e) => {
      if (found !== null) return;
      const m = matchExpr(e, ctx);
      if (m !== null) found = { expr: e, inner: m };
    },
  });
  return found;
}

function listMatch(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], Site> | null {
  const site = findSite(list, ctx);
  return site === null ? null : { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}

function listRewrite(m: Match<readonly Stmt[], Site>): readonly Stmt[] {
  const replacement = rewriteExpr(m.data.inner);
  const target = m.data.expr;
  return mapStmts(m.root, (s) => s, (e) => (e === target ? replacement : e));
}

function listCheck(before: readonly Stmt[], after: readonly Stmt[]): CheckResult {
  return check(before, after);
}

export const literalForms: Pass<readonly Stmt[], Site> = {
  name: "literal-forms",
  stage: "B",
  targets: ["45-regex-literals", "55-typeof-is-masks"],
  catalogue: [29, 30],
  after: ["expr-rebuild"],
  before: ["fn-naming", "reg-split", "var-naming"],
  match: listMatch,
  rewrite: listRewrite,
  check: listCheck,
};
