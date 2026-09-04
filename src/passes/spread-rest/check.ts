// spread-rest checker — docs/specs/passes/17-spread-rest.md §6: expression-
// only, recompute-and-diff. Never trusts the driver's captured match data:
// the site is re-derived from `before` alone by re-running the real matcher
// (`match`, the same function `rewrite` was built from) anchored at the same
// offset, and the canonical expansion of what was *written* is diffed,
// through `effectSequence`, against the matched run's real effect sequence.
import type { Expr, Stmt } from "../ast.ts";
import { effectSequence, identUses, isSafeIdentifier } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { extractFunc, match } from "./match.ts";
import type { PropEl, SpreadRestSite } from "./match.ts";

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const DUMMY: Expr = { k: "ident", name: "r999999" };
const assignDummy = (value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: DUMMY, value } });
const helperCall = (name: string, args: readonly Expr[]): Expr => ({ k: "call", callee: { k: "ident", name }, args });

/** §6 item 1's `expand`: the low-level helper-call form the written site
 *  stands for, built *only* from what was actually written (never from the
 *  matcher's captured data) — a reordered spread source, a dropped element,
 *  or a smuggled receiver changes this expansion's effect sequence. */
function expand(site: SpreadRestSite): readonly Stmt[] {
  if (site.rule === "array") {
    // §2 H1a: the seed's own elements are baked into the array literal —
    // zero effects (effectSequence never records array-literal construction
    // itself). Only the *appended* run (past `seedCount`) is a real
    // sequence of calls/member-writes, plus one member-write iff the real
    // run had a `.length = n` pre-size trim (dropped by the rewrite, but
    // still an effect the matched `before` run actually had).
    const out: Stmt[] = [];
    if (site.seedIsNewArray) out.push(assignDummy({ k: "new", callee: { k: "ident", name: "Array" }, args: [{ k: "lit", text: "0" }] }));
    if (site.hadTrim) out.push({ k: "expr", expr: { k: "assign", target: { k: "member", obj: { k: "ident", name: site.targetName }, prop: { k: "lit", text: "length" }, computed: false }, value: { k: "lit", text: String(site.seedCount) } } });
    for (const el of site.elements.slice(site.seedCount)) {
      if (el.kind === "spread") out.push(assignDummy(helperCall("__hbc_b_arraySpread", [{ k: "ident", name: site.targetName }, el.source, { k: "lit", text: "0" }])));
      else out.push({ k: "expr", expr: { k: "assign", target: { k: "member", obj: { k: "ident", name: site.targetName }, prop: { k: "lit", text: "0" }, computed: true }, value: el.expr } });
    }
    return out;
  }
  if (site.rule === "call") {
    // §2 H1b: the seed itself is `new Array(0)` — a real, observable `new`
    // effect (effectSequence pushes one for every `new`, unconditionally).
    const out: Stmt[] = [assignDummy({ k: "new", callee: { k: "ident", name: "Array" }, args: [{ k: "lit", text: "0" }] })];
    for (const a of site.args) {
      if (a.kind === "spread") out.push(assignDummy(helperCall("__hbc_b_arraySpread", [{ k: "ident", name: "r999998" }, a.source, { k: "lit", text: "0" }])));
      else out.push({ k: "expr", expr: { k: "assign", target: { k: "member", obj: { k: "ident", name: "r999998" }, prop: { k: "lit", text: "0" }, computed: true }, value: a.expr } });
    }
    out.push(assignDummy(helperCall("__hbc_b_apply", [site.callee, { k: "ident", name: "r999998" }, { k: "lit", text: "undefined" }])));
    return out;
  }
  if (site.rule === "object") {
    const out: Stmt[] = [];
    for (const p of site.props) {
      if (p.kind === "spread") out.push(assignDummy(helperCall("__hbc_b_copyDataProperties", [{ k: "ident", name: site.targetName }, p.source])));
      else out.push({ k: "expr", expr: { k: "assign", target: { k: "member", obj: { k: "ident", name: site.targetName }, prop: { k: "lit", text: p.computed ? JSON.stringify(p.key) : p.key }, computed: p.computed }, value: p.value } });
    }
    return out;
  }
  // rest: one call, no other effect — `arguments` itself is untouched.
  return [assignDummy(helperCall("__hbc_b_copyRestArgs", [{ k: "argumentsObject" }, { k: "lit", text: "0" }]))];
}

function realExpand(before: readonly Stmt[], site: SpreadRestSite): readonly Stmt[] {
  if (site.rule === "rest") return before; // no statement-list run to re-expand; handled separately below
  return before.slice(site.rule === "call" ? site.startIndex : site.startIndex, site.endIndex);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const fnBody = ctx.fnBody ?? before;
  const rescan = match(before, { ...ctx, fnBody });
  if (rescan === null) return { ok: false, reason: "no spread-rest site recomputed from before" };
  const site = rescan.data;

  if (site.rule === "rest") {
    // §6 item 4: params grew by exactly one `rest` entry; the call's own
    // identity is replaced by exactly one fresh-name read; every *other*
    // `arguments` use in the body is byte-identical (structural equality —
    // this rung's rewrite never touches any statement outside the func node
    // it targets, so `sameJson` is exact, not approximate).
    const beforeFunc = extractFunc(before[site.funcIndex]!);
    const afterFunc = after.length === before.length ? extractFunc(after[site.funcIndex]!) : null;
    if (beforeFunc === null || afterFunc === null) return { ok: false, reason: "rest rewrite did not preserve the func node" };
    if (afterFunc.params.length !== beforeFunc.params.length + 1) return { ok: false, reason: "rest rewrite did not append exactly one param" };
    const last = afterFunc.params[afterFunc.params.length - 1]!;
    if (last.rest !== true || !isSafeIdentifier(last.name)) return { ok: false, reason: "rest rewrite's appended param is not a safe rest param" };
    if (!sameJson(afterFunc.params.slice(0, -1), beforeFunc.params)) return { ok: false, reason: "rest rewrite changed an existing param" };
    const reads = identUses(afterFunc.body, last.name);
    if (reads.reads !== 1 || reads.writes !== 0) return { ok: false, reason: "rest rewrite's fresh name is not read exactly once" };
    // Deliberately NOT `parses(after)` per site: the stage-B driver already
    // runs `parses` once per (pass, function) on the whole reconstructed body
    // (`src/passes/README.md`); doing it here too both costs a whole-list
    // print+parse on every site of a real bundle and spuriously refuses one
    // whose enclosing list holds an untouched bare `break`/`continue` (legal
    // in the real function, illegal the moment this list alone is wrapped
    // standalone — object-literal/check.ts, commit 3b0ec3a, docs/BUGS.md
    // `stage-b-per-site-parses`).
    return { ok: true };
  }

  const expectedLen = site.rule === "call" ? 1 : 1;
  const startIndex = site.startIndex;
  const endIndex = site.endIndex;
  let head = 0;
  const minLen = Math.min(before.length, after.length);
  while (head < minLen && before[head] === after[head]) head++;
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore--;
    tailAfter--;
  }
  if (head !== startIndex || tailBefore !== endIndex) return { ok: false, reason: "spread-rest did not replace the recomputed run" };
  if (tailAfter - head !== expectedLen) return { ok: false, reason: "spread-rest did not collapse the run to one statement" };

  const written = after[head]!;
  if (written.k !== "expr" || written.expr.k !== "assign") return { ok: false, reason: "the replacement statement is not a plain assign" };

  if (site.rule === "array") {
    if (written.expr.value.k !== "array") return { ok: false, reason: "array rewrite did not produce an array literal" };
    const got = written.expr.value.elements;
    if (got.length !== site.elements.length) return { ok: false, reason: "array rewrite element count mismatch" };
    for (let i = 0; i < got.length; i++) {
      const want = site.elements[i]!;
      const g = got[i]!;
      if (want.kind === "spread") {
        if (g.k !== "spread" || g.arg !== want.source) return { ok: false, reason: "array rewrite spread source is not reference-equal" };
      } else if (g === want.expr ? false : g !== want.expr) return { ok: false, reason: "array rewrite element is not reference-equal" };
    }
  } else if (site.rule === "call") {
    if (written.expr.value.k !== "call") return { ok: false, reason: "call rewrite did not produce a call expression" };
    if (written.expr.value.callee !== site.callee) return { ok: false, reason: "call rewrite callee is not reference-equal" };
    const got = written.expr.value.args;
    if (got.length !== site.args.length) return { ok: false, reason: "call rewrite argument count mismatch" };
    for (let i = 0; i < got.length; i++) {
      const want = site.args[i]!;
      const g = got[i]!;
      if (want.kind === "spread") {
        if (g.k !== "spread" || g.arg !== want.source) return { ok: false, reason: "call rewrite spread source is not reference-equal" };
      } else if (g !== want.expr) return { ok: false, reason: "call rewrite argument is not reference-equal" };
    }
  } else {
    if (written.expr.value.k !== "object") return { ok: false, reason: "object rewrite did not produce an object literal" };
    const got = written.expr.value.props;
    const wantAll: readonly ({ readonly key: string; readonly computed: boolean; readonly value: Expr } | PropEl)[] = [...site.seedProps, ...site.props];
    if (got.length !== wantAll.length) return { ok: false, reason: "object rewrite property count mismatch" };
    for (let i = 0; i < got.length; i++) {
      const want = wantAll[i]!;
      const g = got[i]!;
      if ("kind" in want && want.kind === "spread") {
        if (!("k" in g) || g.k !== "spreadProp" || g.arg !== want.source) return { ok: false, reason: "object rewrite spread source is not reference-equal" };
      } else {
        const w = want as { readonly key: string; readonly computed: boolean; readonly value: Expr };
        if ("k" in g || g.key !== w.key || g.computed !== w.computed || g.value !== w.value) return { ok: false, reason: "object rewrite property is not reference-equal" };
      }
    }
  }

  // §6 item 1: the canonical expansion of the *written* shape must have the
  // same observable effect sequence as the real matched run in `before`.
  const expected = JSON.stringify(effectSequence(expand(site)));
  const actual = JSON.stringify(effectSequence(realExpand(before, site)));
  if (expected !== actual) return { ok: false, reason: "spread-rest changed the observable effect sequence" };

  // See the `rest`-rule branch above: deliberately not re-checked here.
  return { ok: true };
}
