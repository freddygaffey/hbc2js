// docs/specs/05-emitter.md §2 — our own minimal JS node set (~30 kinds), not
// ESTree. Node names are kept ESTree-compatible in spirit so a spec 07 pass that
// wants a parser-based `check` can map them mechanically.
export type Expr =
  | { readonly k: "ident"; readonly name: string }
  /** A pre-rendered literal: number, string, bigint, boolean, null, undefined. */
  | { readonly k: "lit"; readonly text: string }
  | { readonly k: "this" }
  /** The current function's `arguments` object. */
  | { readonly k: "argumentsObject" }
  | { readonly k: "member"; readonly obj: Expr; readonly prop: Expr; readonly computed: boolean }
  | { readonly k: "call"; readonly callee: Expr; readonly args: readonly Expr[] }
  | { readonly k: "new"; readonly callee: Expr; readonly args: readonly Expr[] }
  | { readonly k: "bin"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly k: "logical"; readonly op: "&&" | "||" | "??"; readonly left: Expr; readonly right: Expr }
  | { readonly k: "unary"; readonly op: "!" | "-" | "+" | "~" | "typeof " | "void " | "delete "; readonly arg: Expr }
  | { readonly k: "assign"; readonly target: Expr; readonly value: Expr }
  | { readonly k: "cond"; readonly test: Expr; readonly then: Expr; readonly else: Expr }
  | { readonly k: "array"; readonly elements: readonly Expr[] }
  | { readonly k: "object"; readonly props: readonly ObjectProp[] }
  | { readonly k: "seq"; readonly exprs: readonly Expr[] }
  | { readonly k: "func"; readonly name: string | null; readonly params: readonly string[]; readonly body: readonly Stmt[] };

export interface ObjectProp {
  readonly key: string; // identifier text, or a rendered literal when `computed`
  readonly computed: boolean;
  readonly value: Expr;
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "=="
  | "!="
  | "==="
  | "!=="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&"
  | "|"
  | "^"
  | "<<"
  | ">>"
  | ">>>"
  | "instanceof"
  | "in";

export type Stmt =
  | { readonly k: "expr"; readonly expr: Expr }
  | { readonly k: "decl"; readonly kind: "let" | "const" | "var"; readonly names: readonly string[] }
  | { readonly k: "init"; readonly kind: "let" | "const" | "var"; readonly name: string; readonly value: Expr }
  | { readonly k: "if"; readonly test: Expr; readonly then: readonly Stmt[]; readonly else: readonly Stmt[] }
  /** `label: while (test) { … }`; `test` absent is `while (true)` (the M4 baseline, spec 04 §2). */
  | { readonly k: "while"; readonly label: string | null; readonly test?: Expr; readonly body: readonly Stmt[] }
  /** `label: do { … } while (test);` — spec 07 loop-cond. */
  | { readonly k: "do-while"; readonly label: string | null; readonly test: Expr; readonly body: readonly Stmt[] }
  /** `label: for (init; test; update) { … }` — spec 07 for-header. */
  | { readonly k: "for"; readonly label: string | null; readonly init: Expr | null; readonly test: Expr; readonly update: Expr | null; readonly body: readonly Stmt[] }
  | { readonly k: "labeled"; readonly label: string; readonly body: readonly Stmt[] }
  | { readonly k: "break"; readonly label: string | null }
  | { readonly k: "continue"; readonly label: string | null }
  | { readonly k: "return"; readonly arg: Expr | null }
  | { readonly k: "throw"; readonly arg: Expr }
  | { readonly k: "try"; readonly block: readonly Stmt[]; readonly param: string; readonly handler: readonly Stmt[] }
  | { readonly k: "switch"; readonly disc: Expr; readonly cases: readonly SwitchCase[] }
  | { readonly k: "func"; readonly name: string; readonly params: readonly string[]; readonly body: readonly Stmt[] }
  | { readonly k: "directive"; readonly text: string }
  /**
   * `(function () { … })();` — the whole module's wrapper. Without it every
   * emitted `function _fnN` and every runtime helper becomes an own property of
   * the global object in a script context, which the equivalence checker's
   * `globals` trace record sees and reports as a divergence (correctly: the
   * original program does not define them).
   */
  | { readonly k: "iife"; readonly body: readonly Stmt[] }
  | { readonly k: "comment"; readonly text: string }
  /** Verbatim text — used only for the runtime helper prelude (§7). */
  | { readonly k: "raw"; readonly text: string };

export interface SwitchCase {
  /** null = `default:`. */
  readonly test: Expr | null;
  readonly body: readonly Stmt[];
}

// --- convenience constructors -------------------------------------------------

export const id = (name: string): Expr => ({ k: "ident", name });
export const lit = (text: string): Expr => ({ k: "lit", text });
export const UNDEF: Expr = { k: "lit", text: "undefined" };
export const num = (v: number): Expr => ({ k: "lit", text: renderNumber(v) });
export const member = (obj: Expr, prop: Expr, computed: boolean): Expr => ({ k: "member", obj, prop, computed });
export const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
export const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ k: "bin", op, left, right });
export const un = (op: "!" | "-" | "+" | "~" | "typeof " | "void " | "delete ", arg: Expr): Expr => ({ k: "unary", op, arg });
export const assign = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });

/** Deterministic, round-trippable rendering of a double. */
export function renderNumber(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}
