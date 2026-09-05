// arguments-form matcher -- docs/LOWERING-CATALOGUE.md row R10,
// docs/specs/passes/23-arguments-form-literal-forms.md section 3.1/4.1.
//
// Site = the whole current function body (F1): one match per function, since
// the safety argument (R-A3) is whole-function -- a store to a parameter
// anywhere is observable through a mapped `arguments` read anywhere else.
// `classify` is exported so `check.ts` can re-derive the same verdict from
// `before` alone (spec 23 section 3.1's checker item 3), the same split
// `global-access/match.ts`'s `classifySite` uses.
import type { Expr, Stmt } from "../ast.ts";
import { identUses } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason = "already-bare" | "no-fn-params" | "helper-escapes" | "mapped-arguments" | "arguments-shadowed" | "nested-capture";

export interface ArgumentsFormSite {
  /** Every `__hbc_arguments(arguments)` call node accepted for replacement. */
  readonly calls: readonly Expr[];
}

export type ArgumentsFormMatch = Match<readonly Stmt[], ArgumentsFormSite>;

export type ClassifyResult = { readonly ok: true; readonly site: ArgumentsFormSite } | { readonly ok: false; readonly reason: RefuseReason };

const HELPER = "__hbc_arguments";

/** The emitter's own two shapes for "the current function's arguments
 *  object" (spec 23 section 1.1): `{k:"argumentsObject"}` for an ordinary
 *  function, `{k:"ident", name:"arguments"}` for the synthetic trees the
 *  acceptance tests hand-build. A generator body's own reify call passes
 *  `id("__args")` instead (`src/emit/function.ts:191`), which matches
 *  neither shape -- that is what makes R-A6 (generator-body) fall out of
 *  R-A2 below with no separate check. */
function isBareArguments(e: Expr): boolean {
  return e.k === "argumentsObject" || (e.k === "ident" && e.name === "arguments");
}

type UsageRole = "value" | "member-obj-read" | "member-obj-write" | "assign-target";

interface ScanResult {
  readonly calls: Expr[];
  /** R-A2: `__hbc_arguments` appears somewhere other than an accepted call's callee. */
  helperEscapes: boolean;
  /** R-A3(b): a candidate call's value is used as anything other than the object of a read member expression. */
  unsafeUsage: boolean;
  /** R-A3(a): some parameter name is the target of an assignment anywhere in the body. */
  paramWritten: boolean;
  /** R-A4: the body declares a binding named `arguments`. */
  shadowed: boolean;
  /** R-A5: a nested function reads a name a candidate call's result was assigned into. */
  nestedCapture: boolean;
}

/** Whole-body scan, stopping at every nested `k:"func"` boundary (a separate
 *  Hermes function, already processed under its own context -- the same
 *  "func (separate frame)" convention every generic helper in `ast.ts`
 *  follows). Statement sub-lists (`if`/`while`/`try`/`switch`/...) ARE
 *  descended into: this rung's site is the whole function body, not one
 *  statement list, so there is exactly one call to this scan per function. */
function scan(fnBody: readonly Stmt[], paramNames: ReadonlySet<string>): ScanResult {
  const result: ScanResult = { calls: [], helperEscapes: false, unsafeUsage: false, paramWritten: false, shadowed: false, nestedCapture: false };
  const capturedNames = new Set<string>();

  const visitExpr = (e: Expr, role: UsageRole): void => {
    if (e.k === "call" && e.callee.k === "ident" && e.callee.name === HELPER) {
      if (e.args.length === 1 && isBareArguments(e.args[0]!)) {
        result.calls.push(e);
        // Only "the object of a read member expression" (spec 23 section
        // 4.1 R-A3(b)) is safe; everything else -- a call argument, a
        // return value, an assignment's RHS to a plain identifier ("stored
        // into a variable that later escapes", handled conservatively by
        // treating the store itself as the escape rather than tracing the
        // variable's later uses) -- counts against R-A3(b).
        if (role !== "member-obj-read") result.unsafeUsage = true;
        return;
      }
      result.helperEscapes = true;
      return;
    }
    if (e.k === "ident" && e.name === HELPER) {
      result.helperEscapes = true;
      return;
    }
    switch (e.k) {
      case "member":
        visitExpr(e.obj, "member-obj-read");
        if (e.computed) visitExpr(e.prop, "value");
        return;
      case "assign":
        if (e.target.k === "ident") {
          if (paramNames.has(e.target.name)) result.paramWritten = true;
          visitExpr(e.value, "value");
          if (e.value.k === "call" && e.value.callee.k === "ident" && e.value.callee.name === HELPER) capturedNames.add(e.target.name);
        } else if (e.target.k === "member") {
          visitExpr(e.target.obj, "member-obj-write");
          if (e.target.computed) visitExpr(e.target.prop, "value");
          visitExpr(e.value, "value");
        } else {
          visitExpr(e.target, "assign-target");
          visitExpr(e.value, "value");
        }
        return;
      case "call":
      case "optcall":
      case "new":
        visitExpr(e.callee, "value");
        e.args.forEach((a) => visitExpr(a, "value"));
        return;
      case "optmember":
        visitExpr(e.obj, "member-obj-read");
        if (e.computed) visitExpr(e.prop, "value");
        return;
      case "bin":
      case "logical":
        visitExpr(e.left, "value");
        visitExpr(e.right, "value");
        return;
      case "unary":
        visitExpr(e.arg, "value");
        return;
      case "cond":
        visitExpr(e.test, "value");
        visitExpr(e.then, "value");
        visitExpr(e.else, "value");
        return;
      case "array":
        e.elements.forEach((x) => visitExpr(x, "value"));
        return;
      case "object":
        e.props.forEach((p) => visitExpr("k" in p ? p.arg : p.value, "value"));
        return;
      case "spread":
        visitExpr(e.arg, "value");
        return;
      case "seq":
        e.exprs.forEach((x) => visitExpr(x, "value"));
        return;
      case "template":
        e.exprs.forEach((x) => visitExpr(x, "value"));
        return;
      case "tagged":
        visitExpr(e.tag, "value");
        visitExpr(e.quasi, "value");
        return;
      case "destructure":
        visitExpr(e.source, "value");
        return;
      case "func":
        if (e.name !== null && e.name === "arguments") result.shadowed = true;
        for (const param of e.params) {
          if (param.name === "arguments") result.shadowed = true;
          if (param.init !== undefined) visitExpr(param.init, "value");
        }
        // A separate register frame (D12a/`ast.ts` convention): do not
        // descend into its body here -- R-A5 is checked below, once, via
        // `identUses(...).nested` against every name a candidate's result
        // was assigned into, which already sees into nested frames.
        return;
      default:
        return; // ident, lit, this, argumentsObject
    }
  };

  const visitStmt = (s: Stmt): void => {
    switch (s.k) {
      case "expr":
        visitExpr(s.expr, "value");
        break;
      case "init":
        if (s.name === "arguments") result.shadowed = true;
        visitExpr(s.value, "value");
        if (s.value.k === "call" && s.value.callee.k === "ident" && s.value.callee.name === HELPER) capturedNames.add(s.name);
        break;
      case "decl":
        for (const n of s.names) if (n === "arguments") result.shadowed = true;
        break;
      case "if":
        visitExpr(s.test, "value");
        s.then.forEach(visitStmt);
        s.else.forEach(visitStmt);
        break;
      case "while":
        if (s.test !== undefined) visitExpr(s.test, "value");
        s.body.forEach(visitStmt);
        break;
      case "do-while":
        visitExpr(s.test, "value");
        s.body.forEach(visitStmt);
        break;
      case "for":
        if (s.init != null) visitExpr(s.init, "value");
        visitExpr(s.test, "value");
        if (s.update != null) visitExpr(s.update, "value");
        s.body.forEach(visitStmt);
        break;
      case "for-in":
      case "for-of":
        visitExpr(s.left, "value");
        visitExpr(s.right, "value");
        s.body.forEach(visitStmt);
        break;
      case "labeled":
      case "iife":
        s.body.forEach(visitStmt);
        break;
      case "return":
        if (s.arg != null) visitExpr(s.arg, "value");
        break;
      case "throw":
        visitExpr(s.arg, "value");
        break;
      case "try":
        if (s.param === "arguments") result.shadowed = true;
        s.block.forEach(visitStmt);
        s.handler.forEach(visitStmt);
        break;
      case "switch":
        visitExpr(s.disc, "value");
        for (const c of s.cases) {
          if (c.test != null) visitExpr(c.test, "value");
          c.body.forEach(visitStmt);
        }
        break;
      case "func":
        if (s.name === "arguments") result.shadowed = true;
        for (const param of s.params) if (param.name === "arguments") result.shadowed = true;
        break; // a separate frame: never descend
      default:
        break; // break, continue, directive, comment, raw
    }
  };

  fnBody.forEach(visitStmt);
  for (const name of capturedNames) {
    if (identUses(fnBody, name).nested > 0) result.nestedCapture = true;
  }
  return result;
}

/** Spec 23 section 4.1's whole predicate, re-derivable from `fnBody`/`ctx`
 *  alone -- what `match` uses, and what `check.ts` re-runs against `before`. */
export function classify(fnBody: readonly Stmt[], ctx: PassContext): ClassifyResult {
  const fnParams = ctx.fnParams;
  const paramNames = new Set(fnParams?.names ?? []);
  const scanResult = scan(fnBody, paramNames);
  if (scanResult.calls.length === 0) return { ok: false, reason: "already-bare" }; // R-A0
  if (fnParams === undefined) return { ok: false, reason: "no-fn-params" }; // R-A1
  if (scanResult.helperEscapes) return { ok: false, reason: "helper-escapes" }; // R-A2 (subsumes R-A6: a generator body's reify call passes `__args`, never the bare-arguments shape, so it is never a "candidate" and its bare `__hbc_arguments` ident is left over as an escape)
  if (paramNames.has("arguments") || scanResult.shadowed) return { ok: false, reason: "arguments-shadowed" }; // R-A4
  const mapped = !isStrict(fnBody) && fnParams.simple && fnParams.names.length > 0;
  if (mapped && (scanResult.paramWritten || scanResult.unsafeUsage)) return { ok: false, reason: "mapped-arguments" }; // R-A3
  return { ok: true, site: { calls: scanResult.calls } };
}

/** The function's own prologue directive (`src/emit/function.ts:805`) is the
 *  one signal stage B has for strictness -- and, because Hermes resolves
 *  strict-mode inheritance at compile time, is already correct for a nested
 *  closure whose enclosing scope is strict (its own `header.flags.strictMode`
 *  bit is set too), so there is no separate "walk the enclosing functions"
 *  step to perform here. */
function isStrict(fnBody: readonly Stmt[]): boolean {
  return fnBody.some((s) => s.k === "directive" && s.text === "use strict");
}

export function match(list: readonly Stmt[], ctx: PassContext): ArgumentsFormMatch | null {
  if (ctx.fnBody === undefined || list !== ctx.fnBody) return null;
  const result = classify(list, ctx);
  return result.ok ? { root: list, nodes: [list], data: result.site, at: { functionIndex: ctx.functionIndex, offset: 0 } } : null;
}
