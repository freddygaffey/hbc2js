# 08 — `jsx-recover` (stage B, catalogue row **R6**, D20)

> The highest-visibility rung: it makes a screen read like React. It is a
> **readability-only, opt-in** transform — it changes *how a React element is
> written*, never *what the code does* — and it is **off during the
> equivalence gate** (§7), so the gate stays 0-DIVERGENT and `--passes=none`
> stays byte-identical.

## 1. Purpose

Recognise the React element-creation calls the RN/Babel-jsx transform emits
and rewrite them to JSX:

```js
jsx(Text, { style: s, children: "hello" })          →  <Text style={s}>hello</Text>
jsxs(View, { style: s, children: [a, b] })           →  <View style={s}>{a}{b}</View>
React.createElement(Row, { item }, child)            →  <Row item={item}>{child}</Row>
```

Element trees nest: a child that is itself a recovered element recurses to a
nested JSX element. Nothing else in the file changes.

## 2. Baseline shapes read (rn-template-0.72 `module_422`, `module_315`)

The pass runs **last in stage B**, so by the time it fires, `expr-rebuild`,
`call-shape`, `fn-naming`, `var-naming`, `spread-rest` have already turned the
raw M4 shape

```js
r7 = r6.jsx; r0 = {}; r0.style = r9; r0.children = r8;
r0 = Reflect.apply(r7, r3, [r6b, r0]);      // baseline (passes off)
```

into an ordinary call with a materialised props object:

```js
jsx(Text, { style: descStyle, children: description })   // what jsx-recover sees
```

Two runtimes appear in the corpus:

* **Automatic runtime** (`react/jsx-runtime`, the RN default): `jsx(type,
  config[, key])` and `jsxs(...)`; `jsxDEV(type, config, key, isStaticChildren,
  source, self)` at `-dev`. **Children live in the `children` prop**, not in
  trailing args. `jsxs` ⇒ `children` is an array. `key` is the **3rd argument**,
  not a config field.
* **Classic runtime**: `createElement(type, props, ...children)` — children are
  **trailing args**; `key`/`ref` live *inside* `props`.

## 3. AST shape the rung owns

Input: a `call` node whose callee is a proven jsx factory (§4). Output: a **new
`jsx` Expr node** (framework addition, §7.1):
`{ k:"jsx", tag: string|Expr, attrs: JsxAttr[], children: JsxChild[], selfClosing }`,
where `JsxAttr = { name, value: Expr | null } | { spread: Expr }` and a child is
an `Expr` (wrapped `{expr}`) or a raw text literal. The rung may rewrite only
the `call` sub-tree it matched; it never touches statements or non-React calls
(D12a §3.2).

## 4. Matcher — recognising the factory without a name

The callee is never resolvable to `react` by import (D20/§5.3: Metro's
`require` result is opaque; `ctx.module.depsVerdict()` is `null` in the
decompile pipeline). Recognition is therefore **structural**, keyed off the
surviving property/identifier name plus the argument shape:

**A. Automatic runtime (primary, high confidence).** Accept when the callee is
`member(_, "jsx"|"jsxs"|"jsxDEV")` (computed:false, or computed with that string
literal) **or** a bare `ident "jsx"|"jsxs"|"jsxDEV"|"_jsx"|"_jsxs"|"_jsxDEV"`,
**and** the arg shape holds:
* `args[0]` (type) is a valid tag expression — a string literal, a capitalised
  `ident`, or a `member` chain over idents (`Namespace.Comp`); otherwise refuse
  (`bad-type`);
* `args[1]` (config) is an `object` literal, `null`/`undefined`, or a lone
  spread source `ident`; otherwise refuse (`dynamic-config`);
* `jsx`/`jsxDEV` ⇒ arity ≤ its signature; `jsxs` additionally asserts the
  `children` config field is an `array` (else refuse `jsxs-nonarray`).

These three property names are effectively unique to `react/jsx-runtime`, so
name+arg-shape alone is a safe accept.

**B. Classic runtime (guarded).** `member(obj, "createElement")` or
`ident "createElement"` is **ambiguous with `document.createElement`** (found
live in `module_239`: `r7.document.createElement`). Accept **only** when the
props arg (`args[1]`) is an `object` literal, `null`, or a spread `ident`
(DOM's 2nd arg is a string/options, never a React props object) **and** the
type arg is a capitalised `ident`/`member` **or** the receiver `obj` is proven
React (a `depsVerdict()` hit, or the same module also reads `.jsx`/`Fragment`/
`Component`/`createContext` off `obj`). A bare-lowercase-string type with no
sibling evidence ⇒ refuse (`ambiguous-createElement`). Lean on runtime A;
classic is a minority of the corpus (3 sites vs 156 jsx/jsxs in rn-template).

`match` returns `null` (fixed-point) on a node whose callee is already a `jsx`
node's own inverse, so a second run rewrites nothing (PL-08).

## 5. Writer

* **tag** — string literal type → its text as the tag; `ident`/`member` →
  that name as a `<Comp>` / `<Ns.Comp>` tag. A `Fragment`/`.Fragment` type →
  a `<Fragment>` tag (the named identifier, **not** bare `<>` — `<>` needs
  React's Fragment implicitly in scope and would not round-trip faithfully).
* **attrs** — from the config object, each `ObjectProp` except `children`:
  `k: v` → `name={v}`; a string-literal value → `name="text"`; a non-object
  config (`ident`) or a spread element → `{...x}` spread attr. `key`: automatic
  runtime's 3rd arg → `key={…}`; classic runtime's `key`/`ref` config fields
  stay attributes.
* **children** — automatic: the `children` field. Single element → one child
  (recurse if it is itself a matched jsx call); `array` → each element a child;
  a `.map(...)` call → `{arr.map(...)}`; a `cond` → `{c ? a : b}`; a string
  literal → text; any other expr → `{expr}`. Classic: the trailing args, same
  per-child treatment.
* **self-closing** when there are no children.

## 6. Checker — faithful re-expression, offline, no runtime

`check` proves the D12 equivalence **structurally, without executing**: the
rung owns an **inverse** `jsxToCall(node)` that lowers the emitted `jsx` node
back to the exact `jsx(type, config, key)` / `createElement(type, props,
…children)` call it came from, and `check` asserts `jsxToCall(after)` is
structurally identical to the matched `before` call (same callee node, same arg
exprs in order). Because the mapping is an exact bijection this is the whole
guard — it needs no Node run and no Babel. (Plain `parses` from §4.3 does *not*
apply: JSX is not runnable JS; the inverse-equality check replaces it.) Refuse
if the inverse does not reproduce `before` (e.g. a config field that is neither
attr nor `children`, an un-tag-able type slipped through).

## 7. Runnable-vs-JSX output, and how the gate stays green

**Decision — design (a): readability-only, gated OFF during the equivalence
trace.** JSX cannot run under Node without a transform, and the harness
executes output. So:

1. `jsx-recover` is **not in the default pass registry order**. It is added
   only in a human-facing mode — `--jsx` (implied by `--split`'s per-module
   output). The equivalence gate runs the *default* pipeline, whose output is
   ordinary `jsx(Type, props)` / `createElement(...)` **calls** — runnable JS.
   The gate never sees a `jsx` node ⇒ **0-DIVERGENT preserved**, and
   `--passes=none` byte-identity is untouched.
2. In `--jsx` mode the printer (framework, §7.1) renders the `jsx` node as
   real JSX; that file is human-facing and is **not** run through the runtime
   gate. Its faithfulness is guaranteed by §6's offline inverse-equality check,
   not by execution.
3. PL-09 ("PASS with passes on and off") is satisfied because the on/off pair
   the gate compares is the default pipeline, where jsx-recover is absent — no
   JSX in either arm.

**Framework additions required (like ladder §7):** the `jsx` Expr node in
`src/emit/ast.ts`, its printer in `src/emit/print.ts` (both reachable from
`src/passes/ast.ts`, not from the rung), an `emitJsx` flag threaded from
`--jsx`, and R6 added to the catalogue's Readability rows.

## 8. Ordering, fixtures, metric, acceptance

* **Ordering** — `after: ["call-shape", "expr-rebuild", "fn-naming",
  "var-naming", "spread-rest", "optional-chain"]`; **last in stage B** (ladder
  §2): it needs plain calls, named callees, a materialised props object, and
  spread already folded.
* **Fixtures** — add a hbc-compilable pair under `tests/fixtures/constructs/`
  (no Metro needed): a `source.js` that already calls a stub `React.createElement`
  (classic) and one that calls a stub automatic `jsx`/`jsxs`, compiled at all
  five versions. Assert (1) JSX recovered in `--jsx`; (2) §6 inverse-equality;
  (3) the default-pipeline output is unchanged and still PASS. Corpus targets:
  rn-template `module_422`/`module_315`, react-navigation, expensify.
* **Metric** — residue owner for element-creation calls: **% of jsx/jsxs/
  jsxDEV/createElement call sites turned to JSX** per bundle (rn-template
  baseline: 156 jsx/jsxs + 3 createElement sites), plus the abandonment-reason
  histogram (`bad-type`, `dynamic-config`, `ambiguous-createElement`, …).
* **Acceptance** — every target green; the metric reported in STATUS; gate
  0-DIVERGENT with the default pipeline; `--passes=none` byte-identical;
  `--jsx` output passes §6 on every recovered site, 0 unfaithful.

## 9. Version differences

The idiom is version-independent (all of 84/94/96/98/99): the jsx-runtime
transform is a source→source Babel pass that runs *before* hermesc, so the
factory call and its property name (`.jsx`/`.jsxs`/`.jsxDEV`/`.createElement`)
survive identically at every bytecode version. No `Pass.versions?` predicate is
needed. The only variation is `-dev` builds emitting `jsxDEV` with the extra
`key,isStaticChildren,source,self` args — handled by A above.

## 10. Implementation notes (2026-09-01, first merge — `src/passes/jsx-recover/`)

What the rung actually sees differs from §2's source-level reading: by the
time stage B reaches it the bytecode has **spilled every operand to a
register**, and `expr-rebuild` cannot fold them back because a member read /
`require()` call sits between each definition and the call (measured on
rn-template `module_422`/`module_315` and fixture `59-jsx-runtime-calls`, all
five versions):

```js
r7 = r6(r4[r9]).jsx;      // factory callee spilled (149 such spills vs 5 direct `.jsx(` calls in rn-template)
r6 = _e997_2.Text;        // type spilled
r4 = {};                  // config built by stores
r4.style = r12;
r4.children = r11;
r6 = r7(r6, r4);          // the call
```

So §4's recognition is done **through the registers**, with the same
"nearest preceding definition, no intervening write" resolution
`template-literal` documents, and the rung is a multi-statement site:

* **Callee**: a register whose nearest definition (in this list; in a
  *dominating* sibling labeled block — the structurer's `L0: {…} L1: {…}`
  shape puts `module_422`'s definitions in the block *before* the call's,
  top-level and ahead of any `break`; or in an enclosing list, with no write
  on any path in between) is `X.jsx`/`X.jsxs`/`X.jsxDEV`/`X.createElement`.
  That definition is **kept** (identification only): `factory.callee` records
  the register so `jsxToCall` reproduces `r7(…)` exactly, and the JSX hides it.
* **Type**: a valid tag expression in place, or a register whose in-list
  definition is one — **absorbed** (definition deleted, the tag printed). A
  definition found only in a sibling/enclosing list is kept and shown through
  the node's presentation-only `tagDisplay` (`<_e997_2.Text>` instead of
  `<r6>`; the inverse still yields `r6`). A bare identifier is a tag when it
  does **not** start with a lowercase letter (Babel's `isCompatTag`): env slots
  `_e0_2` qualify, registers `rN` never do.
* **Config / children**: an object literal in place, or a register defined
  `rP = {…}` and filled by `rP.k = v` stores — absorbed into the attrs; `jsxs`
  children likewise from `rA = new Array(n)` + in-order index stores (an array
  literal in place also works; anything else is `jsxs-nonarray`). The
  automatic runtime's key (3rd argument) prints as the first attribute.
* **Guards** (all recomputed by `check`, §6): every value that moves to the
  call is pure, or is the single impure one with only pure statements between
  it and the call and the lowered order unchanged (`moved-impure`); nothing
  that survives between a deleted definition and the call mentions its
  register (`clobbered-span`) or writes a name a moved value reads
  (`input-clobbered`); a moved value may read an absorbed register only from
  before that register's deleted definition (`reads-absorbed`); each absorbed
  register is dead after the call — redefined there, by the next plain store
  with only simple statements between, or the list is the function body and
  ends (`not-dead`); the list is not inside a `try` (`in-try`). The deleted
  statements are register writes and fresh-object stores only, so the lowered
  call evaluates the same observable effects in the same order.
* **Checker** (§6) compares `jsxToCall(node)` with the call *with the absorbed
  operands substituted* (`JsxSite.resolved`, built from the raw collected
  props, not from the node), asserts `after` equals the fold recomputed from
  `before`, and `parses` the lowered output. `Reflect.apply(rF, rO, [args])`
  with a factory `rF` (`call-shape`'s residue when the member was spilled) is
  counted as a site and refused `reflect-apply-callee`.
* **Framework** (§7.1): `jsx` Expr node + `jsxToCall` in `src/emit/ast.ts`;
  printer `PrintOptions.jsx` (default lowers to the call, so `parses`,
  `node --check` and every effect walker see runnable JS); `Pass.optIn` +
  `EnabledPassOptions.optIn` (registered last, absent by default); CLI `--jsx`
  (skips `node --check`; with `--split` runs the full pipeline on every module
  and prints JSX); `EmitOptions.jsx`; `SplitOptions.passes`/`jsx`.

**Metric (§8), rn-template-0.72:** 154 element-creation sites (149 through a
spilled callee + 5 direct; 3 `createElement`), **15 recovered (9.7%)**;
refusals `bad-type` 82, `reflect-apply-callee` 25, `not-dead` 11,
`jsxs-nonarray` 6, `clobbered-span` 3, `in-try` 1. Fixture 59: 10 of 11
automatic sites (9 at v99, whose hoisted type register is kept and shown
via `tagDisplay`) + the direct `createElement` site recovered (the eleventh is a
`jsxs` whose children is a `.map(…)` call — §4 refuses it by design; the two
`Reflect.apply` classic sites are `call-shape` residue). Floor in
`tests/gate/passes/jsx-recover.test.ts`: 8%.

**Next** (residue owners, by size): `bad-type` — types read off a
`require(dep)` *call* (`r13(r0[r15]).ReloadInstructions`) are not a tag
expression; naming the require result (D17 / `closure-naming`) or a
`tagDisplay`-style kept alias for the member's base would recover them;
`reflect-apply-callee` belongs to `call-shape` (R3b with a spilled member);
`not-dead`/`clobbered-span` need a real liveness walk (hoist `expr-rebuild`'s
`isDeadAfter` into the framework) and outer-element absorption across the
`L0`/`L1` labeled blocks the dark-mode conditional produces.
