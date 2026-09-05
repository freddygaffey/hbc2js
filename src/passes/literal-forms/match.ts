// literal-forms matcher -- docs/LOWERING-CATALOGUE.md rows 29 (L-R, regex)
// and 30 (L-T, TypeOfIs masks), docs/specs/passes/23-arguments-form-literal-forms.md
// section 3.2/4.2.
//
// Both sub-forms are local expression rewrites with no whole-function state,
// so this file's `match` is expression-granular (`Expr` in, `Expr` out) --
// `index.ts` wraps it into the list-granular `Pass` the driver expects.
import type { Expr } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason = "already-raised" | "no-provenance" | "non-literal-args" | "not-constructible" | "round-trip-differs" | "unprintable" | "impure-operand" | "not-mask-shaped";

export type LiteralFormsSite = { readonly form: "regex"; readonly pattern: string; readonly flags: string } | { readonly form: "t1"; readonly x: Expr; readonly str: string } | { readonly form: "t2"; readonly x: Expr } | { readonly form: "t3"; readonly x: Expr };

export type LiteralFormsMatch = Match<Expr, LiteralFormsSite>;

// The eight strings `typeof` can produce (spec 23 section 1.4/4.2 P-T1),
// as `lit`'s already-quoted text.
const TYPEOF_RESULTS = new Set(['"undefined"', '"object"', '"boolean"', '"number"', '"string"', '"bigint"', '"symbol"', '"function"']);

/** P-T3/R-T1: `x` is an identifier, a register read (also an `ident` in this
 *  AST), or a plain non-computed member chain over those -- the only shapes
 *  T2/T3 may duplicate the evaluation of. */
function isSimpleOperand(e: Expr): boolean {
  if (e.k === "ident") return true;
  return e.k === "member" && !e.computed && isSimpleOperand(e.obj);
}

function sameOperand(a: Expr, b: Expr): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isNullLit(e: Expr): boolean {
  return e.k === "lit" && e.text === "null";
}

/** Recognises `typeof x === "object" && x !== null || x === null` -- the
 *  `Object|Null` disjunction `src/emit/typeofis.ts`'s `disjunction` builds
 *  for mask 258, association included (`(a && b) || c`, P-T1). Returns the
 *  shared operand, or `null` for anything else (including a differently
 *  shaped `||`). */
function matchObjectNullDisjunction(e: Expr): { readonly x: Expr } | null {
  if (e.k !== "logical" || e.op !== "||") return null;
  const left = e.left;
  if (left.k !== "logical" || left.op !== "&&") return null;
  const isObjectTest = left.left.k === "bin" && left.left.op === "===" && left.left.left.k === "unary" && left.left.left.op === "typeof " && left.left.right.k === "lit" && left.left.right.text === '"object"';
  if (!isObjectTest) return null;
  const x = (left.left as Extract<Expr, { k: "bin" }>).left as Extract<Expr, { k: "unary" }>;
  const xExpr = x.arg;
  const isNotNull = left.right.k === "bin" && left.right.op === "!==" && sameOperand(left.right.left, xExpr) && isNullLit(left.right.right);
  const isEqNull = e.right.k === "bin" && e.right.op === "===" && sameOperand(e.right.left, xExpr) && isNullLit(e.right.right);
  if (!isNotNull || !isEqNull) return null;
  return { x: xExpr };
}

function matchRegex(e: Extract<Expr, { k: "new" }>): LiteralFormsMatch | null {
  if (e.fromRegExpTable !== true) return null; // R-L1
  if (e.args.length !== 2 || e.args[0]!.k !== "lit" || e.args[1]!.k !== "lit") return null; // R-L2
  const rawPattern = e.args[0]!.text;
  const rawFlags = e.args[1]!.text;
  let pattern: string;
  let flags: string;
  try {
    pattern = JSON.parse(rawPattern) as string;
    flags = JSON.parse(rawFlags) as string;
  } catch {
    return null; // R-L2: not a real string literal
  }
  if (typeof pattern !== "string" || typeof flags !== "string") return null; // R-L2
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return null; // R-L3: not constructible in the decompiler's own runtime
  }
  const body = re.source;
  if (/[\n\r\u2028\u2029]/.test(body) || body.startsWith("*")) return null; // R-L5
  let reparsed: RegExp;
  try {
    reparsed = new RegExp(body, flags);
  } catch {
    return null; // R-L4: the escaped body does not even re-parse
  }
  if (reparsed.source !== re.source || reparsed.flags !== re.flags) return null; // R-L4
  return { root: e, nodes: [e], data: { form: "regex", pattern: body, flags }, at: { functionIndex: -1, offset: 0 } };
}

export function match(e: Expr, ctx: PassContext): LiteralFormsMatch | null {
  void ctx; // both sub-forms are pure expression-shape recognisers
  if (e.k === "new") return matchRegex(e as Extract<Expr, { k: "new" }>);
  if (e.k === "unary" && e.op === "!") {
    const inner = e.arg;
    // T1: `!(typeof x === "<s>")`.
    if (inner.k === "bin" && inner.op === "===" && inner.left.k === "unary" && inner.left.op === "typeof " && inner.right.k === "lit" && TYPEOF_RESULTS.has(inner.right.text)) {
      const x = inner.left.arg;
      if (!isSimpleOperand(x)) return null; // R-T1
      return { root: e, nodes: [e], data: { form: "t1", x, str: inner.right.text }, at: { functionIndex: -1, offset: 0 } };
    }
    // T3: `!(<Object|Null disjunction>)`.
    const t2 = matchObjectNullDisjunction(inner);
    if (t2 !== null) {
      if (!isSimpleOperand(t2.x)) return null; // R-T1
      return { root: e, nodes: [e], data: { form: "t3", x: t2.x }, at: { functionIndex: -1, offset: 0 } };
    }
    return null;
  }
  if (e.k === "logical" && e.op === "||") {
    // T2: the bare `Object|Null` disjunction.
    const t2 = matchObjectNullDisjunction(e);
    if (t2 !== null) {
      if (!isSimpleOperand(t2.x)) return null; // R-T1
      return { root: e, nodes: [e], data: { form: "t2", x: t2.x }, at: { functionIndex: -1, offset: 0 } };
    }
  }
  return null;
}
