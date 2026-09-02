# 15 — `default-params` (stage B, catalogue row **24**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else. Batch 3; runs after `expr-rebuild`, `global-access`, `call-shape`.

**Correction (docs/PUSHBACK.md P-8, 2026-09-02).** §2 and §4 below describe
the stage-B guard as an `if (rX !== U) {} else { …default… }` — that shape
never reaches stage B. The idiom the matcher (`src/passes/default-params/
match.ts`) actually recognises is one **labeled block per defaulted
parameter**, each with a *tail* `break`:

```js
L0: {
  rX = arguments[k];      // may also carry a later parameter's own load (v94)
  if (rX !== U) {
    break L0;             // param WAS passed — skip the default entirely
  }
  …default body, ending by assigning rX…
  break L0;
}
```

`label-clean`'s own L2 rule (`docs/specs/passes/06-label-clean.md` §4) does
not collapse this into an if/else: L2 only credits the tail set of a
`seq`/labeled body from its *last* element, and here the guarding `if` is
not last (the default body and its own trailing `break` follow it) — so
label-clean refuses and the labeled-block shape survives unchanged into
stage B. §2's baseline-shape table and §4's scan below are the *original,
uncorrected* text, kept for its per-version measurement notes (load/guard
interleaving, the `U` operand) — those parts are still accurate — but read
`src/passes/default-params/match.ts`'s own header comment and
`docs/lowering/default-params.md` §7 for the real shape the implementation
matches, and `docs/BUGS.md`'s default-params-prune-leak row for a framework
gap (`pruneRegisterDecls`) the real idiom exposed: a register can now be
live *only* inside a parameter's own default, which the body-only liveness
scan didn't know to check.

## 0. Before you write code: row 24 is single-version

`docs/LOWERING-CATALOGUE.md` row 24 is `✅ single-version` (v94 only), which
PL-06 refuses. The v99 shape is confirmed below — it is the *same* idiom with
two cosmetic differences (§2) — but the implementer must still re-read
`hermesc -dump-bytecode` for `51-default-params` at v94 and v99, add the v99
evidence to `docs/lowering/default-params.md` §7, and flip the Confidence
column to `✅ verified` in the same commit as the pass.

## 1. Purpose

Hermes does not put a defaulted parameter in the function's declared parameter
list at all. It sets the bytecode `paramCount` to *(params before the first
default) + 1*, and each defaulted parameter is read out of the `arguments`
object and given its value by an `undefined` guard in the function prologue.
`src/emit/function.ts:166` already derives `namedParams` from that count, so
the emitter prints a shorter signature than the source had.

Before (`51-default-params` v94 `fn#3` `chainedDefaults`, after
`expr-rebuild`):

```js
function chainedDefaults() {
  let r0, r1, r2, r3, r4;
  r0 = arguments[0];
  r3 = arguments[1];
  r1 = arguments[2];
  r4 = 1;
  r2 = undefined;
  if (r0 !== r2) {
  } else {
    r0 = r4;
  }
  if (r3 !== r2) {
  } else {
    r3 = r0 + r4;
  }
  if (r1 !== r2) {
  } else {
    r1 = r0 + r3;
  }
  r2 = ",";
  r0 = r0 + r2 + r3 + r2 + r1;
  return r0;
}
```

After (register names are `var-naming`'s job, later):

```js
function chainedDefaults(r0 = 1, r3 = r0 + 1, r1 = r0 + r3) {
  let r2;
  r2 = ",";
  return r0 + r2 + r3 + r2 + r1;
}
```

## 2. Baseline shapes (measured, v94 and v99)

One defaulted parameter at 0-based index `k` is exactly two ingredients:

**(a) the load** — `rX = arguments[k]` as
`{k:"init"|"expr"}` whose value is
`{k:"member", obj:{k:"argumentsObject"}, prop:{k:"lit", text:"k"}, computed:true}`.

**(b) the guard** — an `if` with an **empty `then`** and the default in the
`else`:

```js
if (rX !== U) {
} else {
  …statements that end by assigning rX…
}
```

where `U` is either the literal `undefined` or a register whose only write in
this function is the literal `undefined`.

| | v94 | v99 |
|---|---|---|
| load/guard interleaving | all loads first, then all guards (`chainedDefaults`) | load `k` may sit immediately before guard `k` (`chainedDefaults` at v99) |
| the `undefined` operand | usually a spilled register (`r2 = undefined`) | often the inline literal (`if (r2 !== undefined)`, `_fn4`) |
| declared-param count | `paramCount - 1` (`- 2` when a rest param is present, `function.ts:166`) | same, rest not counted in `paramCount` |
| everything else | identical | identical |

Both shapes must be accepted; neither is a version test — a `Pass.versions?`
predicate is **not** appropriate here (the rung fires at every version).

Verified sites in `51-default-params`: `greet(a1)` + `arguments[1]`;
`withSideEffectDefault()` + `arguments[0]` with an *impure* default body
(`_e0_0` increment); `chainedDefaults()` + `arguments[0..2]` with each default
reading the previously-defaulted registers; `defaultUsesFunction(a1)` +
`arguments[1]` whose default reads the declared param `a1`.

## 3. AST the rung owns

**May match/rewrite:** the `params` list and the leading statements of **one**
`func` node (statement form `{k:"func"}` or expression form `{k:"func"}`) that
is a member of the matched statement list.

**Must not touch:** any statement after the last guard; the guard's `then`
branch (it must be empty — that is the shape, not a thing to rewrite); any
`arguments` read that is not a plain integer index; any `if` whose `then` is
non-empty; the module wrapper `_fn0` (it has no parameters); a function whose
body still contains `__pc`/`__exc` inside the matched prologue run.

### Framework prerequisite F15 (`src/emit/ast.ts` + `print.ts`)

`func.params` is `readonly string[]` and cannot express a default. Replace it
with a parameter record — **this same change is what `17-spread-rest` needs
for rest parameters, so land it once**:

```ts
export interface Param {
  readonly name: string;
  readonly init?: Expr;   // default value  (this rung)
  readonly rest?: true;   // rest element   (17-spread-rest)
}
export const p = (name: string): Param => ({ name });
```

`func.params: readonly Param[]` in both `Expr` and `Stmt` positions.
`print.ts:156,232` print `params.map(x => (x.rest ? "..." : "") + x.name + (x.init ? " = " + expr(x.init) : "")).join(", ")`; an `init` that is a
`k:"seq"` must be parenthesised (`(a = (f(), 1))`), so route it through the
printer's assignment-precedence path, not `expr()` raw. `src/emit/function.ts`
builds `params.push(p(\`a${i}\`))`. `src/passes/ast.ts`: `walk`/`mapExpr` must
recurse into `param.init`; `freeNames` must count `param.name` as **bound** and
`param.init`'s idents as free; `effectSequence` must record a `func`'s params
as *nothing* (a function definition evaluates no default — they run per call),
exactly as it records the body as nothing today. `scope-check.ts` must treat
`param.name` as a binding and `param.init` as evaluated in the function's
scope.

Getting `freeNames` wrong here is the only way this rung can corrupt a later
naming pass; write the unit test for it in `tests/gate/passes/framework.test.ts`.

## 4. Matcher

Site = one statement list `L`. Find the first member of `L` that is (or whose
value is) a `func` node `F` not yet rewritten. Let `B = F.body` and
`n = F.params.length`.

Scan `B` from index 0, maintaining `next = n` (the 0-based index of the
parameter we expect to see defaulted next) and a set `moved` of registers this
run has claimed. Classify each statement:

* **load(k, rX)** — shape (a) with `k` an integer literal. Record
  `loadOf[k] = rX`. Refuse the whole function if `rX` is not `/^r\d+$/`
  (`protocol-name`).
* **guard(rX)** — shape (b). Let `k` be the index with `loadOf[k] === rX`.
  Require `k === next`; otherwise **stop the scan here** (`out-of-order` — do
  not refuse what was matched so far; a prefix is a valid, smaller match).
  `next++`; add `rX` to `moved`.
* **`isPureStmt` and writes no register in `moved` and reads no register
  written later in `B`** — skip it, but *keep* it in the body (see §5).
* anything else — **stop the scan**.

Stop also at the first guard whose preconditions fail. The match is the run
`B[0 .. last-guard-index]` plus `{ F, defaults: [{k, rX, body}] }`. Empty
`defaults` → return `null` (`no-defaults`).

Per-guard preconditions, all recomputed in `check`:

1. `then` is `[]` and the test is `{k:"bin", op:"!==", left: ident rX, right: U}`
   with `U` the literal `undefined` or a register whose single write in `B` is
   that literal and `identUses(B, U).nested === 0`; otherwise refuse
   (`not-undefined-guard`).
2. `identUses(B, rX)` shows **exactly one** write outside the guard body (the
   load) and `nested === 0` for the load; otherwise refuse
   (`param-register-reused`). A register that a later loop reassigns is not a
   parameter.
3. Every `else`-branch statement's free registers are: `a1…a{n}` (declared
   params), registers in `moved` (earlier defaults — legal, JS evaluates
   defaults left to right in the same scope), `rX` itself, or names free in
   the *enclosing* scope (env slots `_eD_S`, helpers, globals). A read of any
   other body register → refuse (`default-reads-body-state`). This is the
   precondition that makes "move it into the parameter list" sound.
4. The `else` branch contains no `break`/`continue`/`return`/`throw`/`try`
   and no `func` whose body reads a body-local register; otherwise refuse
   (`non-expression-default`). It *may* be impure — `withSideEffectDefault`'s
   increment is the point of the fixture.
5. No statement strictly before this guard in `B` (excluding earlier loads and
   guards of this run) is impure. Otherwise refuse (`effect-before-default`) —
   parameter defaults run *before* the body, so an impure body statement
   cannot be jumped over.
6. `F` is not the module wrapper and `B` contains no `__pc`/`__exc` write
   before the last guard (`generator-or-try-prologue`).
7. `k === F.params.length + (number of defaults already accepted in this run)`
   — the parameter positions must be contiguous with the declared ones;
   otherwise stop the scan (`non-contiguous-index`).

## 5. Writer

For each accepted `{k, rX, body}` in index order:

* build `init` = the `else` branch collapsed to a single `Expr`: if `body` is
  one `{k:"expr"|"assign"}` assigning `rX = E`, `init = E`; if it is a run of
  statements `S1…Sm` ending in `rX = E` where every `Si` is
  `{k:"expr"}` (no declarations, no control flow), `init = seq(S1.expr, …, E)`
  — the emitter's `k:"seq"` prints as a comma expression, which is exactly
  what `withSideEffectDefault`'s `(sideEffectCount++, 'default-' + n)` was in
  the source. Anything else → that guard is not accepted (`unlowerable-default`);
* append `{ name: rX, init }` to `F.params`;
* delete the load statement and the guard statement from `B`.

Everything else in `B` keeps its order and its identity. The skipped pure
statements stay where they are — do **not** hoist them; a pure statement that
happened to sit between two loads is still a body statement.

Finally, drop `rX` from any `{k:"decl"}` in `B` that declares it (it is a
parameter now, and re-declaring a parameter with `let` is a SyntaxError — this
is the step that makes `parses` fail if you forget it).

**Idempotence.** After the rewrite there is no `arguments[k]` load and no
guard for `rX`, and `F.params.length` has grown, so the `k === params.length`
contiguity test in `match` fails on the rung's own output. Assert it: run the
pass twice, second run must report zero sites.

## 6. Checker

Class: **expression-only** (ladder §4.3), with one extra obligation because a
parameter default is *not* in the body's effect sequence.

1. `expressionOnlyCheck(before, after)` restricted to `B` **with each accepted
   guard's `else` branch spliced back in at the guard's position** — i.e.
   build `beforeʹ` = `after`'s body with, for each moved parameter, the
   statements `rX = arguments[k]; if (rX !== undefined) {} else { …init… }`
   re-inserted at the head in index order, and require
   `effectSequence(beforeʹ)` deep-equals `effectSequence(before)`. Plain
   `expressionOnlyCheck` would fail (the effects legitimately left the body),
   so this is the honest version of the same test.
2. Recompute every precondition 1–7 of §4 against `before`. Do not trust
   match data (README).
3. `after`'s `F.params` is `before`'s with exactly the accepted records
   appended, in ascending `k`, with `k` contiguous from `before.params.length`.
4. No accepted `rX` appears in a `{k:"decl"}` in `after`, and no accepted `rX`
   is a free name of any *enclosing* scope (`freeNames`) — otherwise the new
   binding shadows something.
5. `identUses(after.body, rX).writes === identUses(before.body, rX).writes - 2`
   for each moved register (the load and the guard's store are gone).
6. The driver's `parses(fnBody)` (01 F1). This is the backstop for F15's
   printer.

**D14 / semantics.** The rewrite is exact, and each equivalence is worth
naming because default parameters are one of the three places (with
optional-chain and destructuring) where evaluation order is the whole game:

* **When the default fires.** JS applies a parameter default iff the argument
  is *absent or `undefined`*. `arguments[k] === undefined` is true in exactly
  those two cases. Identical, at every version.
* **Order.** JS evaluates defaults left to right, before the body, each in a
  scope where the preceding parameters are already bound. Hermes's guards run
  in ascending `k` at the top of the body, each seeing the previous guard's
  result. Precondition 3 + 5 (contiguity, ascending order, nothing impure
  before the last guard) is what makes those two the same schedule. A guard
  out of order is *stopped at*, not accepted, which is why the matcher yields
  a prefix rather than refusing.
* **`arguments` is unmapped** at every Hermes version (D14) and is unmapped in
  any JS function that has a default parameter, so the two agree on
  `arguments[k]` after the body writes `rX`: neither aliases.
  `42-rest-params`'s `mutateParamAffectsArguments` is the fixture that would
  catch a regression here; it must keep its verdict.
* **`f.length`.** JS counts parameters before the first default or rest.
  Recovering `chainedDefaults(r0 = 1, …)` gives `length === 0`, which is what
  the source had and what `paramCount - 1 === 0` already encoded. The rewrite
  moves output *towards* ground truth. Nonetheless, if a fixture's verdict
  moves, that is a hard stop (PL-09).
* **TDZ.** A parameter default that reads a *later* parameter throws
  `ReferenceError` in JS; precondition 3 only admits *earlier* ones, so the
  rung can never construct that program.

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `stage: "B"`,
`after: ["expr-rebuild", "global-access", "call-shape"]`,
`before: ["destructure", "var-naming"]`. `destructure` (16) needs the
`= {}` / `= []` parameter default already in the parameter list before it can
recognise a destructured parameter (ladder §2: "rows 22/24 share one
matcher"), which is why the ladder puts this rung first of the two.
`var-naming` runs last so it names `r0` once, in the parameter list, rather
than naming it as a body register this rung then moves.

**Refuse (per-site, distinct reason strings):** `no-defaults`,
`protocol-name`, `out-of-order`, `not-undefined-guard`, `param-register-reused`,
`default-reads-body-state`, `non-expression-default`, `effect-before-default`,
`generator-or-try-prologue`, `non-contiguous-index`, `unlowerable-default`.

**Fixtures (red→green).** `targets: ["51-default-params",
"39-destructuring-params", "42-rest-params"]`, all five HBC versions plus
`.min`/`.obf`. `42` is there as a *negative*: its `combine(first, ...rest)`
has no defaults and this rung must leave it entirely alone. Unit tests on
hand-built lists: positives for a single default, three chained defaults, an
impure `seq` default, a default reading a declared param; negatives for an
out-of-order index, a non-empty `then`, a guard whose register is reassigned
later, an impure statement before the guard, `arguments[k]` with a computed
index; ≥1 site the `check` refuses.

**Corpus metric** (`tools/passes-metrics.ts`): count of *default-guard
prologue runs* — statement pairs matching shape (a)+(b) — remaining in the
printed output. Baseline is 9 in `51` + 4 in `39` per version. **Floor: ≥ 90 %
of them removed** across `tests/fixtures/constructs/**` at all five versions ×
base/`.min`/`.obf`, and **≥ 75 %** on the RN template bundle. Secondary: the
count of emitted functions whose body's first statement reads
`arguments[<int>]` falls to **≤ 10 %** of baseline; zero fixture verdict
moves; PL-09 holds; `--passes=none` byte-identical. Residual sites carry a
recorded reason; the histogram goes in `docs/STATUS.md`.

**Estimated size:** ~200 lines across `match/rewrite/check`, ~60 lines for F15
across `ast.ts`/`print.ts`/`function.ts`/`scope-check.ts`, ~250 lines of tests.

## 8. Open questions

1. **F15 ownership.** `Param` is needed by this rung *and* by `17-spread-rest`.
   Land it as its own commit ("F15: `func.params` becomes `Param[]`") with the
   printer, `scope-check` and `passes/ast.ts` updates and a green gate, then
   build both rungs on it. If batch 3 is split across agents, whoever starts
   first lands F15.
2. **Does the guard ever appear with a non-empty `then`?** Every observed site
   has `then: []` because the structurer keeps the compare's polarity. A
   version or an optimiser level that inverts it would need a second rule
   (`if (rX === undefined) { … }`). The implementer should grep the RN
   template bundle for both polarities and, if the inverted form exists, add
   it as rule (b′) with the same preconditions rather than normalising in
   `expr-rebuild`.
3. **Destructured-parameter interaction.** `39`'s `makeUser({…} = {})` shows a
   default (`= {}`) on a parameter that `destructure` will then turn into a
   pattern. This rung should produce `function makeUser(r1 = {})` and stop;
   spec 16 §4 rule D-P picks it up from there. Confirm the two rungs compose
   on `39` at v94 and v99 before either is called done.
