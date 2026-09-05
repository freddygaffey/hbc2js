// docs/specs/05-emitter.md §2 — our own minimal JS node set (~30 kinds), not
// ESTree. Node names are kept ESTree-compatible in spirit so a spec 07 pass that
// wants a parser-based `check` can map them mechanically.
export type Expr =
  /**
   * A bare identifier. `global: true` marks a reference the decompiler
   * *deliberately* emitted as a proven global read (the `global-access` rung
   * folding `globalThis.print` -> `print`, EM-01 / scope-check.ts): such a
   * name is intentionally free of any module binding, so `checkBindings`
   * accepts it instead of raising `E_UNBOUND_IDENT`. An *unmarked* bare name
   * that is not in scope is still an emitter bug and still throws. Only a
   * global *read* is marked — a write or a `DeclareGlobalVar` keeps its
   * `globalThis.<name>` form (D14).
   */
  | { readonly k: "ident"; readonly name: string; readonly global?: true }
  /** A pre-rendered literal: number, string, bigint, boolean, null, undefined. */
  | { readonly k: "lit"; readonly text: string }
  | { readonly k: "this" }
  /** The current function's `arguments` object. */
  | { readonly k: "argumentsObject" }
  | { readonly k: "member"; readonly obj: Expr; readonly prop: Expr; readonly computed: boolean }
  /**
   * F18 (docs/specs/passes/18-optional-chain.md §3): `obj?.prop` /
   * `obj?.[prop]` — the guarded member link of a `?.` chain. `obj`'s own
   * effects (including any earlier `optmember`/`optcall` link) always run;
   * `prop`'s read/access runs only when `obj` is not nullish. The printer
   * never re-parenthesises `obj` in a way that would break this scope
   * (`(a?.b).c` throws where `a?.b.c` does not).
   */
  | { readonly k: "optmember"; readonly obj: Expr; readonly prop: Expr; readonly computed: boolean }
  | { readonly k: "call"; readonly callee: Expr; readonly args: readonly Expr[] }
  /** F18: `callee?.(args)` — the guarded call link. `thisIsBase` records
   *  that the call's receiver (`Reflect.apply`'s second argument in the
   *  bytecode form) was the callee's own base register, per §4 precondition
   *  5's `?.()` receiver rule; the printer does not need it (a bare
   *  `?.(...)` call never sets `this` from the printed source), but a
   *  future writer/checker step that needs to tell `a.b?.()` (this = `a`)
   *  from a detached call can use it. */
  | { readonly k: "optcall"; readonly callee: Expr; readonly args: readonly Expr[]; readonly thisIsBase: boolean }
  /**
   * F23-2 (docs/specs/passes/23-arguments-form-literal-forms.md section 2):
   * `fromRegExpTable` marks a `new RegExp(pattern, flags)` node built by
   * `literals.ts`'s `regExpExpr` from a `CreateRegExp` bytecode instruction's
   * string-table ids — the only provenance the `literal-forms` rung (L-R) may
   * rely on to raise it to a `/pattern/flags` literal. A genuine source-level
   * `new RegExp(...)` (no flag) is a real `RegExp` global read that a literal
   * would erase, so it must never be rewritten. Printing, `sameShape` and
   * `effectSequence` ignore the flag entirely: it changes no observable
   * behaviour by itself.
   */
  | { readonly k: "new"; readonly callee: Expr; readonly args: readonly Expr[]; readonly fromRegExpTable?: true }
  /**
   * F23-3: a regex literal `/pattern/flags`, the `literal-forms` rung's (L-R)
   * sole writer output for a `fromRegExpTable` `new RegExp` node. `pattern`/
   * `flags` are the literal's raw source text (never re-escaped by the
   * printer — the rung itself computed the escaped form via
   * `new RegExp(p, f).source`). Printed at `PRIMARY` precedence: `/x/g.test(s)`
   * is valid JS with no parentheses needed as a member base.
   */
  | { readonly k: "regex"; readonly pattern: string; readonly flags: string }
  | { readonly k: "bin"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly k: "logical"; readonly op: "&&" | "||" | "??"; readonly left: Expr; readonly right: Expr }
  | { readonly k: "unary"; readonly op: "!" | "-" | "+" | "~" | "typeof " | "void " | "delete "; readonly arg: Expr }
  | { readonly k: "assign"; readonly target: Expr; readonly value: Expr }
  | { readonly k: "cond"; readonly test: Expr; readonly then: Expr; readonly else: Expr }
  | { readonly k: "array"; readonly elements: readonly Expr[] }
  | { readonly k: "object"; readonly props: readonly (ObjectProp | SpreadProp)[] }
  | { readonly k: "seq"; readonly exprs: readonly Expr[] }
  /**
   * F17 (docs/specs/passes/17-spread-rest.md §3): `...arg`, valid only
   * inside an array literal's `elements`, a call/`new`'s `args`, or (as a
   * bare `Expr` there too — array/call `Expr[]` already admit any `Expr`).
   * Never a stand-alone statement or anywhere else; `parses` is the
   * backstop for a `spread` node the printer would emit somewhere illegal.
   */
  | { readonly k: "spread"; readonly arg: Expr }
  /**
   * F14 (docs/specs/passes/14-template-literal.md §3): `` `q0${e0}q1…` ``.
   * Invariant `quasis.length === exprs.length + 1`. Each `quasis[i]` is the
   * **raw** source text of the chunk — the printer emits it verbatim between
   * the backticks and `${`/`}` and escapes nothing, so whoever builds the
   * node (the `template-literal` rung's writer) owns escaping of `` ` ``,
   * `\` and `${`.
   */
  | { readonly k: "template"; readonly quasis: readonly string[]; readonly exprs: readonly Expr[] }
  /** F14: `` tag`…` `` — `quasi` is always a `k:"template"` node. */
  | { readonly k: "tagged"; readonly tag: Expr; readonly quasi: Expr }
  /**
   * D20 / docs/specs/passes/08-jsx-recovery.md §3: one React element,
   * `<tag attrs…>children…</tag>`. Exists only when the opt-in `jsx-recover`
   * rung ran (`--jsx`). `factory` records the exact element-creation call
   * the node stands for, so `jsxToCall` below is a bijection: the printer
   * lowers the node back to that call unless `PrintOptions.jsx` is set —
   * which is what keeps `parses`, `node --check` and every effect walker
   * honest about a tree that happens to hold JSX.
   */
  | {
      readonly k: "jsx";
      /** The type operand exactly as the call had it. */
      readonly tag: Expr;
      /** Presentation only: when `tag` is a register whose (kept, enclosing-
       *  list) definition provably holds a tag expression at the call, that
       *  expression — `<_e997_2.Text>` instead of `<r6>`. `jsxToCall` ignores it. */
      readonly tagDisplay?: Expr;
      readonly attrs: readonly JsxAttr[];
      readonly children: readonly JsxChild[];
      readonly selfClosing: boolean;
      readonly factory: JsxFactory;
    }
  /**
   * F16 (docs/specs/passes/16-destructure.md §3): `<pattern> = <source>`, the
   * `destructure` rung's sole writer output. `pattern`'s `pid` leaves are
   * assignment targets to already-declared registers (D14: never a fresh
   * binding), so this node is printed at assignment precedence and — in
   * statement position, when `pattern` is a `pobj` — parenthesised by the
   * printer's `expr` statement case, exactly like an object-pattern
   * assignment must be in real JS.
   */
  | { readonly k: "destructure"; readonly pattern: Pattern; readonly source: Expr }
  /**
   * F25-1 (docs/specs/passes/25-yield-async-recovery.md §2): a suspension.
   * `yield <arg>` / `yield* <arg>` / bare `yield` (`arg: null`); `await
   * <arg>`. Produced only by the `yield-recovery` / `async-recovery` rungs
   * when they collapse a generator group back into the `function*` /
   * `async function` it was lowered from. Never pure (`src/passes/ast.ts`'s
   * `isPure` returns false by default for both) and always an effect in
   * `effectSequence`: a suspension is observable and may never be reordered
   * past anything.
   */
  | { readonly k: "yield"; readonly arg: Expr | null; readonly delegate: boolean }
  | { readonly k: "await"; readonly arg: Expr }
  | {
      readonly k: "func";
      readonly name: string | null;
      readonly params: readonly Param[];
      readonly body: readonly Stmt[];
      /** `true` only for the generator/async resume-dispatcher closure
       *  `emit/function.ts` returns from an `isOpcodeGeneratorBody` function
       *  (docs/BUGS.md, the `r3`/`r15` `E_UNBOUND_IDENT` family). Every other
       *  `k:"func"` node is a genuine Hermes `CreateClosure`, so it owns a
       *  separate, independently-numbered register file (Hermes restarts
       *  `r0` per function) — the invariant `src/passes/ast.ts`'s
       *  `IdentUses.nested` relies on to never follow a register name across
       *  a `func` boundary. This one closure is the sole exception: it is
       *  not a second Hermes function, it is the *same* frame's state
       *  machine re-entered on every resume, so it reads and writes the
       *  enclosing function's own registers directly (no env-slot capture).
       *  `countUses` (`src/passes/ast.ts`) must treat it as transparent —
       *  not a frame boundary — for every name, registers included, or a
       *  register whose only uses are inside this closure reads as dead and
       *  a framework step (`pruneRegisterDecls`) drops its declaration out
       *  from under a live read.
       */
      readonly sameFrame?: true;
      /** F25-1: `function*` / `async function`. Set only by the spec-25
       *  rungs; an emitted Hermes closure never carries either. */
      readonly generator?: true;
      readonly async?: true;
    };

/** `name={value}` (a string `lit` value prints bare, `name="text"`, when it
 *  is JSX-safe), or `{...spread}`. `value: null` is the bare `name` (`true`)
 *  shorthand — the inverse maps it to `name: true`; the rung never emits it. */
export type JsxAttr = { readonly name: string; readonly value: Expr | null } | { readonly spread: Expr };

/** `{expr}`, or a string `lit` child the printer shows as bare text when it
 *  is JSX-safe — `lit` is the very literal node the call carried. */
export type JsxChild = { readonly k: "expr"; readonly expr: Expr } | { readonly k: "text"; readonly lit: Expr };

/**
 * How the element was created — enough to rebuild the call exactly.
 * `automatic` (`react/jsx-runtime`): `callee(type, config[, key, ...rest])`;
 * the config's props are `attrs` with the `children` field re-inserted at
 * index `childrenAt` (`null`: the config had no `children`), as the single
 * child (`childrenShape: "single"`, `jsx`) or an array of them (`"array"`,
 * `jsxs`); `rest` is `jsxDEV`'s trailing `isStaticChildren, source, self`.
 * `classic` (`createElement`): `callee(type, props, ...children)` — `key`/
 * `ref` stay ordinary attrs; `nullProps` is the literal `null`/`undefined`
 * node when the call passed no props object at all.
 */
export type JsxFactory =
  | { readonly runtime: "automatic"; readonly callee: Expr; readonly key: Expr | null; readonly childrenAt: number | null; readonly childrenShape: "single" | "array"; readonly rest: readonly Expr[] }
  | { readonly runtime: "classic"; readonly callee: Expr; readonly nullProps: Expr | null };

/**
 * The exact element-creation call a `jsx` node stands for (spec 08 §6's
 * inverse). Pure; every sub-expression is reused by reference, so a node
 * built from a call and lowered again is structurally identical to it.
 */
export function jsxToCall(e: Extract<Expr, { k: "jsx" }>): Extract<Expr, { k: "call" }> {
  const f = e.factory;
  const attrProps: ObjectProp[] = [];
  const spreads: Expr[] = [];
  for (const a of e.attrs) {
    if ("spread" in a) spreads.push(a.spread);
    else attrProps.push({ key: a.name, computed: false, value: a.value ?? { k: "lit", text: "true" } });
  }
  const childExprs = e.children.map((c) => (c.k === "expr" ? c.expr : c.lit));
  if (f.runtime === "automatic") {
    const props = [...attrProps];
    if (f.childrenAt !== null) {
      const children: Expr = f.childrenShape === "single" && childExprs.length === 1 ? childExprs[0]! : { k: "array", elements: childExprs };
      props.splice(f.childrenAt, 0, { key: "children", computed: false, value: children });
    }
    const config: Expr = spreads.length === 1 && props.length === 0 ? spreads[0]! : { k: "object", props };
    const args: Expr[] = [e.tag, config];
    if (f.key !== null || f.rest.length > 0) args.push(f.key ?? { k: "lit", text: "undefined" });
    args.push(...f.rest);
    return { k: "call", callee: f.callee, args };
  }
  const props: Expr = f.nullProps !== null ? f.nullProps : spreads.length === 1 && attrProps.length === 0 ? spreads[0]! : { k: "object", props: attrProps };
  return { k: "call", callee: f.callee, args: [e.tag, props, ...childExprs] };
}

/**
 * F15 (docs/specs/passes/15-default-params.md §3): a declared parameter.
 * `init` is a default value (`15-default-params`'s own rewrite target);
 * `rest` marks a rest element (`17-spread-rest`). Neither rung is required
 * to set either field — a plain parameter is `{name}`, nothing else.
 */
export interface Param {
  readonly name: string;
  readonly init?: Expr;
  readonly rest?: true;
}
export const p = (name: string): Param => ({ name });

/**
 * F16 §3: a destructuring pattern. `pid` names a register (always already
 * `let`-declared elsewhere in the function — this node never introduces a
 * binding, D14). Both `parr`/`pobj` recurse through `PatternElement`, so a
 * nested pattern (`{ nested: { deep } }`) is just a `pel.target` that is
 * itself a `pobj`/`parr`.
 */
export type Pattern = { readonly k: "pid"; readonly name: string } | { readonly k: "parr"; readonly elements: readonly PatternElement[] } | { readonly k: "pobj"; readonly props: readonly { readonly key: string; readonly value: PatternElement }[] };

/** One array element or object property value. `hole` is an elision
 *  (`[a, , b]`) — array patterns only, never a `pobj` prop value. `prest` is
 *  `...target`, at most one, always last (array rest: the destructure
 *  rung's own inline index-append loop; object rest: its 3-arg
 *  `copyDataProperties` — spec 16 §7's ownership table). */
export type PatternElement = { readonly k: "pel"; readonly target: Pattern; readonly init?: Expr } | { readonly k: "hole" } | { readonly k: "prest"; readonly target: Pattern };

export interface ObjectProp {
  readonly key: string; // identifier text, or a rendered literal when `computed`
  readonly computed: boolean;
  readonly value: Expr;
}

/** F17: `{...arg}` inside an object literal's `props` — object spread
 *  (`docs/specs/passes/17-spread-rest.md` H4). */
export interface SpreadProp {
  readonly k: "spreadProp";
  readonly arg: Expr;
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

/**
 * Bytecode origin of an emitted statement (docs/specs/05-emitter.md §16):
 * the half-open byte range `[start, end)`, relative to function `fn`, of the
 * ONE instruction the statement was lowered from — the same number
 * `src/disasm/print.ts` prints as `[@ N]`. Optional everywhere and never
 * inferred: a statement a later pass synthesised, or one that stands for
 * several blocks, has none. Set and read through `src/emit/origin.ts`'s
 * helpers (`withOrigin`/`originOf`), never written by hand.
 */
export interface Origin {
  /** The Hermes function the instruction belongs to. NOT always the function
   *  being printed: `emitModule` nests a child closure's body inside its
   *  parent's, and every function's offsets restart at 0, so a row without
   *  this field would silently point at the wrong instruction. */
  readonly fn: number;
  readonly start: number;
  readonly end: number;
}

export type Stmt =
  | { readonly k: "expr"; readonly expr: Expr; readonly origin?: Origin }
  | { readonly k: "decl"; readonly kind: "let" | "const" | "var"; readonly names: readonly string[]; readonly origin?: Origin }
  | { readonly k: "init"; readonly kind: "let" | "const" | "var"; readonly name: string; readonly value: Expr; readonly origin?: Origin }
  /** `elseIf` (spec 09 F11, src/passes/if-chain): the `else` arm was a chain
   *  link; print.ts renders `} else if (…) {` only when it is exactly one `if`. */
  | { readonly k: "if"; readonly test: Expr; readonly then: readonly Stmt[]; readonly else: readonly Stmt[]; readonly elseIf?: boolean; readonly origin?: Origin }
  /** `label: while (test) { … }`; `test` absent is `while (true)` (the M4 baseline, spec 04 §2). */
  | { readonly k: "while"; readonly label: string | null; readonly test?: Expr; readonly body: readonly Stmt[]; readonly origin?: Origin }
  /** `label: do { … } while (test);` — spec 07 loop-cond. */
  | { readonly k: "do-while"; readonly label: string | null; readonly test: Expr; readonly body: readonly Stmt[]; readonly origin?: Origin }
  /** `label: for (init; test; update) { … }` — spec 07 for-header. */
  | { readonly k: "for"; readonly label: string | null; readonly init: Expr | null; readonly test: Expr; readonly update: Expr | null; readonly body: readonly Stmt[]; readonly origin?: Origin }
  /** `label: for (const|let|var <left> in|of <right>) { … }` — spec 21 for-in/for-of. */
  | { readonly k: "for-in" | "for-of"; readonly label: string | null; readonly decl: "const" | "let" | "var" | null; readonly left: Expr; readonly right: Expr; readonly body: readonly Stmt[]; readonly origin?: Origin }
  | { readonly k: "labeled"; readonly label: string; readonly body: readonly Stmt[] }
  | { readonly k: "break"; readonly label: string | null; readonly origin?: Origin }
  | { readonly k: "continue"; readonly label: string | null; readonly origin?: Origin }
  | { readonly k: "return"; readonly arg: Expr | null; readonly origin?: Origin }
  | { readonly k: "throw"; readonly arg: Expr; readonly origin?: Origin }
  /** `param: null` prints `catch { }` (try-clean/try-shape §3.2, an unread
   *  catch binding — the emitter's own `Catch r = __exc` lowering still runs
   *  inside `handler`; only the surface binding name is dropped). */
  | { readonly k: "try"; readonly block: readonly Stmt[]; readonly param: string | null; readonly handler: readonly Stmt[] }
  | { readonly k: "switch"; readonly disc: Expr; readonly cases: readonly SwitchCase[]; readonly origin?: Origin }
  /** F25-1: `generator`/`async` mark a `function*` / `async function`
   *  declaration recovered by the spec-25 rungs. */
  | { readonly k: "func"; readonly name: string; readonly params: readonly Param[]; readonly body: readonly Stmt[]; readonly generator?: true; readonly async?: true }
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
