// destructure checker — docs/specs/passes/16-destructure.md §6: expression-
// only, via recompute-and-diff. Nothing here trusts the driver's captured
// match data (`README`): the site is re-derived from `before` alone by
// calling the *same* matcher functions the pass itself uses (so a mutation
// to the rewrite that disagrees with what the matcher actually saw is
// caught), and — independently of that re-derivation — the observable
// effect sequence of a canonical expansion of the *written* pattern is
// diffed against the effect sequence of the matched statements in `before`
// (so a mutation that makes matcher and writer agree with *each other* but
// not with reality is still caught: `expand` shares no code with `match.ts`
// or `rewrite.ts`).
import type { Expr, Pattern, Stmt } from "../ast.ts";
import { effectSequence, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { buildPattern, match } from "./match.ts";
import type { DestructureSite } from "./match.ts";

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** §6 item 1's `expand`: a *flat*, control-flow-free reproduction of the
 *  matched run's observable effects (`effectSequence` walks every branch of
 *  an `if`/`while` unconditionally and records nothing for a register-named
 *  assignment or a `bin`/`logical` comparison — AGENT-BRIEF's "registers are
 *  invisible plumbing" — so the exact iterator-protocol control flow the
 *  real idiom uses need not be reproduced, only its calls/member-reads/
 *  member-writes, in order). `__x` is a dummy target; only the RHS's shape
 *  feeds `effectSequence`. */
function expand(pattern: Pattern, source: Expr): readonly Stmt[] {
  // A register-*shaped* dummy (`effectSequence`'s `isVisible` treats a real
  // register as invisible plumbing — no `assign` effect — exactly as the
  // original matched run's own register copies are; a non-register-shaped
  // name here would spuriously add `assign` effects this expansion must not
  // have).
  const X: Expr = { k: "ident", name: "r999999" };
  const callStmt = (callee: string, args: readonly Expr[]): Stmt => ({ k: "expr", expr: { k: "assign", target: X, value: { k: "call", callee: { k: "ident", name: callee }, args } } });
  // `__hbc_iterBegin`/`__hbc_iterNext` always return a 2-tuple the real
  // idiom destructures as `__t = call(...); a = __t[0]; b = __t[1];` (F-
  // "tuple-return" helper convention) — `__t` is not a register, so its own
  // assignment IS a visible `assign` effect, and each `__t[0]`/`__t[1]` read
  // is a `member-read`, both load-bearing for this comparison to be exact.
  // `__hbc_iterClose` is called for effect only, as a bare (unassigned)
  // call statement — no tuple, no extra effects.
  const tupleCall = (callee: string, args: readonly Expr[]): readonly Stmt[] => {
    const t: Expr = { k: "ident", name: "__t" };
    const tup = (i: number): Expr => ({ k: "member", obj: t, prop: { k: "lit", text: String(i) }, computed: true });
    return [{ k: "expr", expr: { k: "assign", target: t, value: { k: "call", callee: { k: "ident", name: callee }, args } } }, { k: "expr", expr: { k: "assign", target: X, value: tup(0) } }, { k: "expr", expr: { k: "assign", target: X, value: tup(1) } }];
  };
  if (pattern.k === "parr") {
    const out: Stmt[] = [...tupleCall("__hbc_iterBegin", [source])];
    for (const el of pattern.elements) {
      if (el.k === "hole" || el.k === "prest") {
        // `prest`: v1 has no array-rest support in the matcher
        // (docs/BUGS.md); kept for the `Pattern` type's completeness only.
        out.push(...tupleCall("__hbc_iterNext", [X, X]));
        continue;
      }
      out.push(...tupleCall("__hbc_iterNext", [X, X]));
      if (el.init !== undefined) out.push({ k: "expr", expr: el.init });
    }
    out.push({ k: "expr", expr: { k: "call", callee: { k: "ident", name: "__hbc_iterClose" }, args: [X, { k: "lit", text: "false" }] } });
    return out;
  }
  // pobj (the only remaining case: `pid` never appears as a whole pattern)
  if (pattern.k !== "pobj") return [];
  const out: Stmt[] = [];
  const restKeyCount = pattern.props.filter((p) => p.value.k !== "prest").length;
  for (const prop of pattern.props) {
    if (prop.value.k === "prest") {
      for (let k = 0; k < restKeyCount; k++) out.push({ k: "expr", expr: { k: "assign", target: { k: "member", obj: X, prop: { k: "lit", text: "0" }, computed: true }, value: { k: "lit", text: "0" } } });
      out.push(callStmt("__hbc_b_copyDataProperties", [X, X, X]));
      continue;
    }
    out.push({ k: "expr", expr: { k: "member", obj: source, prop: { k: "lit", text: JSON.stringify(prop.key) }, computed: false } });
    if (prop.value.k === "pel" && prop.value.init !== undefined) out.push({ k: "expr", expr: prop.value.init });
  }
  return out;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  // §6 item 3: exactly one statement replaced a contiguous run.
  let head = 0;
  const minLen = Math.min(before.length, after.length);
  while (head < minLen && before[head] === after[head]) head++;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }
  if (tailAfter !== head + 1) return { ok: false, reason: "destructure did not replace the run with exactly one statement" };
  const written = after[head]!;
  if (written.k !== "expr" || written.expr.k !== "destructure") return { ok: false, reason: "the replacement statement is not a destructure assignment" };

  // Re-derive the site independently from `before` alone (never trust the
  // driver's captured match data) by re-running the real matcher anchored
  // at the same position — every §4 precondition is re-checked inline by
  // doing so, since `matchArray`/`matchObject` embed them.
  const fnBody = ctx.fnBody ?? before;
  const rescan = match(before.slice(head), { ...ctx, fnBody });
  // `match` scans forward for the *first* site in the sublist starting at
  // `head`; since `before[head]` is exactly where the real match began, a
  // sound recomputation must find a site starting at offset 0 of that
  // sublist (`at.offset === 0`) with the same shape.
  if (rescan === null || rescan.at.offset !== 0) return { ok: false, reason: "no destructure site recomputed from before" };
  const site: DestructureSite = rescan.data;
  const consumedLen = site.endIndex - site.startIndex;
  if (tailBefore - head !== consumedLen) return { ok: false, reason: "destructure consumed the wrong number of statements" };

  const expectedPattern = buildPattern(site);
  if (!sameJson(expectedPattern, written.expr.pattern)) return { ok: false, reason: "the written pattern does not match the recomputed site" };
  if (!sameJson(site.source, written.expr.source)) return { ok: false, reason: "the written source does not match the recomputed site" };

  // §6 item 1: the canonical expansion of what was *written* must have the
  // same observable effect sequence as the matched run actually had.
  const matchedRun = before.slice(head, tailBefore);
  const expected = JSON.stringify(effectSequence(expand(written.expr.pattern, written.expr.source)));
  const actual = JSON.stringify(effectSequence(matchedRun));
  if (expected !== actual) return { ok: false, reason: "destructure changed the observable effect sequence" };

  // §6 item 5: no matched-run label survives as a break/continue target in
  // `after` (labels themselves are gone from the tree since the whole
  // labeled-block run was deleted; a lingering reference would mean some
  // *other* code depended on one of them, which the label-escape
  // precondition should already have refused).
  const labels = new Set<string>();
  for (const s of matchedRun) if (s.k === "labeled") labels.add(s.label);
  let escapes = false;
  const scan = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if ((s.k === "break" || s.k === "continue") && s.label !== null && labels.has(s.label)) escapes = true;
      for (const key of ["then", "else", "body", "block", "handler"] as const) {
        const v = (s as unknown as Record<string, unknown>)[key];
        if (Array.isArray(v)) scan(v as readonly Stmt[]);
      }
    }
  };
  scan(after);
  if (escapes) return { ok: false, reason: "label-escape" };

  if (!parses(after)) return { ok: false, reason: "destructure produced unparseable output" };
  return { ok: true };
}
