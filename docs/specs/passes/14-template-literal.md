# 14 — `template-literal` (stage B, catalogue row **21** + the `getTemplateObject` builtin row)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else. Batch 3; runs after `expr-rebuild` and `global-access`.

## 0. What changed since catalogue row 21 was written (read this first)

Row 21 says template literals are **not** a distinct idiom — "the same
`LoadConstString`/`Add`/`AddS` chain a hand-written `'a' + b + 'c'` would
produce" — and concludes that any recovery pass would be a style heuristic.
**That reading was taken at `-O0`. It is wrong at `-O`, which is what every
fixture and every shipped bundle is built with.** Measured on the committed
fixtures at v94 *and* v99 (`npx tsx src/cli.ts tests/fixtures/constructs/43-template-literals/v94.hbc`):

| Fixture | Source construct | Emitted |
|---|---|---|
| `43-template-literals` | `` `Hello, ${name}!` `` | `Reflect.apply(__hbc_HermesInternal.concat, "Hello, ", ["World", "!"])` |
| `01-if-else-chain` | `'check(' + n + ')'` | `"check(" + rN + ")"` — **zero** `concat` calls |
| `44-tagged-templates` | `'cooked[' + i + ']=' + …` | `+` chain — **zero** `concat` calls |
| `51-default-params` | `'Hello, ' + name + '!'` | `"Hello, " + a1 + r1` — **zero** `concat` calls |

So at `-O` a template literal with ≥1 substitution compiles to
`CallBuiltin HermesInternal.concat`, and ordinary `+` concatenation never
does. That is a real, discriminating idiom, and the discriminator is
*semantic*, not stylistic: `concat` does **ToString** on every piece (see the
helper the emitter prints, and `docs/LOWERING-CATALOGUE.md`'s builtins table),
while `+` does **ToPrimitive** with hint *default*. `{valueOf(){return 1}}`
renders `"1"` under `+` and `"[object Object]"` under `concat`. Hermes cannot
emit `concat` for a `+` without being wrong, which is why it never does.

**Implementer's first task, before writing any code:** re-read
`hermesc -dump-bytecode` for `43` at v94 and v99 at `-O` and at `-O0`, and
rewrite `docs/lowering/template-literals.md` §§2, 4, 5 and the row-21
Confidence column to `✅ verified`. PL-06 refuses `catalogue: [21]` while the
row still says `✅ single-version`. Commit the row with the pass.

## 1. Purpose

Turn the two lowered forms of a template literal back into template syntax.

Before (`43-template-literals` v94/v99 `fn#0`, after `expr-rebuild` +
`global-access`):

```js
r5 = Reflect.apply(__hbc_HermesInternal.concat, "Line one\nLine two with ", [r6.length, " items\nLine three"]);
r8 = __hbc_b_getTemplateObject(0, false, "a\\n", "b\\tc", r4, "a\n", "b\tc", r4);
r1 = r5(r8, 42, 43);
```

After:

```js
r5 = `Line one
Line two with ${r6.length} items
Line three`;
r1 = r5`a\n${42}b\tc${43}d`;
```

## 2. Baseline shapes (both observed at v94 **and** v99, identical)

| Emitted by | Shape |
|---|---|
| `CallBuiltin HermesInternal.concat` via `applyCall` | `Reflect.apply(__hbc_HermesInternal.concat, C0, [S0, C1, S1, C2, …])` |
| same, when the callee was spilled | `Reflect.apply(rK, C0, […])` with `rK = __hbc_HermesInternal.concat` earlier in the list |
| `CallBuiltin getTemplateObject` | `__hbc_b_getTemplateObject(id, dup, …strings)` |
| the tag call itself | an ordinary `call` whose first argument is that value |

**Flat chunk/substitution list.** Let `flat = [C0, ...args]`. The elements at
even indices are the *cooked chunks* (always string literals), the odd indices
are the *substitutions* (arbitrary expressions). `flat.length` is either
`2n+1` (template ends with a chunk) or `2n` (template ends with a
substitution — Hermes elides the trailing empty chunk). Verified:

* `` `Hello, ${name}!` `` → `["Hello, ", "World", "!"]` (odd, 3)
* `` `${i}:${it}` `` → `["", a2, ":", a1]` (even, 4 — trailing `""` elided)
* `computeExpr`'s 4-substitution template → `["", r9, " + ", r8, " = ", r16, ", ", r9, " * ", r8, " = ", r10]` (even, 12)

**`getTemplateObject(id, dup, …strings)`.** `id` is the *call-site id* the
builtin caches on (one frozen object per site, per the builtins table);
`dup` is a boolean. When `dup` is `true` the remaining `n` arguments are the
strings, used as both `.raw` and cooked. When `dup` is `false` there are `2n`
arguments: the first `n` are **raw**, the second `n` are **cooked**.
Verified at v94 and v99 on `44-tagged-templates`:

```
(0, false, "a\\n", "b\\tc", r4, "a\n", "b\tc", r4)   // n=3, r4 = "d"
(r16, r15, r14, r13)                                  // r16=1, r15=true, r14="<p>", r13="</p>"
(r16, r15, r14)                                       // r16=2, r15=true, r14="no subs here"
```

Note every argument may arrive as a *register identifier*, not a literal: the
matcher must resolve, never assume.

## 3. AST the rung owns

**May match/rewrite:** one `call` expression whose callee is
`member(ident "__hbc_HermesInternal", lit "concat")` (or an identifier proved
to hold it), reached through `Reflect.apply`; one `call` to
`ident "__hbc_b_getTemplateObject"` together with the single `call` that
consumes its value.

**Must not touch** (the ladder's §3.2 list for sugar rungs, made concrete):
statements outside the captured run; any `+`/`bin` expression — this rung
**never** converts a `+` chain to a template, at any operand count, with or
without a multi-line literal (that heuristic is what row 21 warned about and
it is now unnecessary); `Reflect.apply` calls to anything else (they are
`call-shape`'s); `__hbc_HermesInternal.concat` reached with a non-literal
`this`; any other `__hbc_b_*` helper.

### Framework prerequisite F14 (`src/emit/ast.ts` + `print.ts`)

`Expr` has no template node. Add two, and only these:

```ts
| { readonly k: "template"; readonly quasis: readonly string[]; readonly exprs: readonly Expr[] }
| { readonly k: "tagged";   readonly tag: Expr; readonly quasi: Expr /* k:"template" */ }
```

Invariant `quasis.length === exprs.length + 1`. `quasis[i]` holds the **raw**
source text of the chunk — the printer emits it verbatim between backticks and
`${`/`}`, escaping only `` ` ``, `\` and `${` — so the writer, not the
printer, owns escaping. `precedence("template") = 20` (primary);
`precedence("tagged") = 18` (member/call level, so `` (a+b)`x` `` parenthesises
its tag). `walk`/`mapExpr` in `src/passes/ast.ts` must recurse into `exprs`
and `tag`; `effectSequence` must treat a `template` as its substitutions in
order and a `tagged` as *(tag shape, exprs.length + 1)* — the same
`(callee, argc)` record the untagged form produced. Missing that last line is
the one way this rung can fire and then be abandoned by its own checker.

## 4. Matcher

Site = one statement list `L`. Walk expressions pre-order; capture the first
rewritable shape. Helper used by both rules:

```
stringLiteralValue(e, ctx) -> string | null
  e is {k:"lit"} whose text is a quoted string  -> its decoded value
  e is {k:"ident", name:/^r\d+$/} with exactly one write in ctx.fnBody whose
    value is such a literal, identUses(...).nested === 0, and that write
    dominates this list (i.e. is in ctx.fnBody at a lower pre-order index and
    the register has no other write) -> that value
  otherwise -> null
```

**T1 — untagged template.** `Reflect.apply(F, C0, ARGS)` where

1. `F` is `member(ident "__hbc_HermesInternal", lit "concat", computed:false)`,
   or an `rN` whose single write in `ctx.fnBody` is exactly that member
   expression (`nested === 0`); otherwise refuse (`unresolved-concat`);
2. `ARGS` is a literal `{k:"array"}` (never a spread-materialised identifier);
   otherwise refuse (`dynamic-args`);
3. `flat = [C0, ...ARGS.elements]`; `stringLiteralValue(flat[0]) !== null` and
   every even index has `stringLiteralValue !== null`; otherwise refuse
   (`non-literal-chunk`) — a computed chunk means the concat did not come from
   a template;
4. `flat.length >= 2` (a `concat` with only chunks is not something Hermes
   emits; refuse `no-substitutions`);
5. no element is a `{k:"seq"}` (refuse `seq-argument`).

→ chunks `q[i] = stringLiteralValue(flat[2i])`, substitutions
`e[i] = flat[2i+1]`. If `flat.length` is even, append `q[n] = ""`.

**T2 — tagged template.** In `L`, a statement `A` containing
`__hbc_b_getTemplateObject(ID, DUP, …S)` assigned to `rT`, and a later
statement `B` in the *same* list containing `call(TAG, [rT, ...SUBS])` where:

1. `stringLiteralValue` resolves every element of `S`; `DUP` resolves (same
   walk, for `true`/`false` literals) to a boolean; `ID` resolves to a number.
   Otherwise refuse (`unresolved-template-object`);
2. `DUP === true` → `raw = S`, `cooked = S`; `DUP === false` → `S.length` is
   even, `raw = S.slice(0, S.length/2)`, `cooked = S.slice(S.length/2)`;
   otherwise refuse (`raw-cooked-mismatch`);
3. `raw.length === SUBS.length + 1`; otherwise refuse (`arity-mismatch`);
4. `identUses(ctx.fnBody, rT).reads === 1` and `.writes === 1` and
   `.nested === 0` — the template object is consumed exactly once; otherwise
   refuse (`shared-template-object`);
5. **`ID` occurs as the first argument of exactly one
   `__hbc_b_getTemplateObject` call in the whole `ctx.fnBody`**; otherwise
   refuse (`duplicated-site-id`). This is not pedantry: the builtin's caching
   means one id is one JS template site with one object identity, and a
   structurer-duplicated block (`finally-dedup`, spec 00 §5.1) would otherwise
   turn one site into two objects;
6. every statement strictly between `A` and `B` is `isPureStmt` and does not
   write any register `SUBS` or `TAG` reads; otherwise refuse
   (`interleaved-effect`). (`A` and `B` adjacent is the common case.)
7. for each `i`, `cook(raw[i]) === cooked[i]`, where `cook` is the JS
   template-cooking of the raw text (process escapes; `undefined` for an
   invalid escape). Otherwise refuse (`raw-does-not-cook`) — that is the guard
   that stops the writer inventing a template whose printed raw text would
   cook to something else.

→ tag `TAG`, quasis `raw`, substitutions `SUBS`.

## 5. Writer

**T1** — replace that one `call` node with
`{k:"template", quasis: q.map(escapeForTemplate), exprs: e}`. `escapeForTemplate`
turns the *cooked* chunk value back into raw source text: escape `` ` ``, `\`
and `${`; leave literal newlines as newlines (that is the readability win —
`43`'s multi-line template prints as two source lines); render control
characters other than `\n` as `\xNN`.

**T2** — replace `B`'s `call(TAG, [rT, …SUBS])` with
`{k:"tagged", tag: TAG, quasi: {k:"template", quasis: raw, exprs: SUBS}}` and
**delete statement `A`** (its only consumer is gone). Statement `A` is deleted
only when it is exactly `init`/`assign` of `rT` with the helper call as the
whole value; if the helper call is nested inside a larger expression, refuse
(`nested-template-object`). `raw` is used verbatim — it is already raw text.

`src/emit/print.ts` owns parentheses. Never wrap the result yourself.

**Idempotence (PL-08).** Structural, as the README demands for stage B: after
the rewrite there is no `concat` call and no `getTemplateObject` call at the
site, so `match` returns `null` on its own output. State that in the pass's
unit test — run the pass twice on one list and assert zero sites the second
time.

## 6. Checker

Class: **expression-only** (ladder §4.3).

1. `expressionOnlyCheck(before, after)`. For T1 this holds only if
   `effectSequence` records the `template` as its substitutions in order and
   the removed `Reflect.apply` as `(callee-shape, argc)` — F14 above; if that
   framework line is missing the check fails honestly and every site is
   abandoned, which is the correct failure mode.
2. Recompute, do not trust `match`: the chunk resolution (`stringLiteralValue`
   on every even `flat` index in `before`), `nested === 0` for every register
   the resolution walked, and the `ARGS` array literalness.
3. T1: `after`'s `quasis.length === before`'s chunk count and
   `exprs.length === substitution count`; every `exprs[i]` is the *same node*
   (reference-equal) as the corresponding `flat[2i+1]` — the rung never
   rebuilds a substitution.
4. T2: `raw.length === SUBS.length + 1`; `cook(raw[i]) === cooked[i]` for all
   `i` (recomputed); `identUses(before, rT).reads === 1`; the id is unique in
   `ctx.fnBody`; statement `A` is gone from `after` and nothing else moved
   (`after.length === before.length - 1` and the two lists agree elsewhere).
5. `parses(fnBody)` — the driver runs it once per function (01 F1). This is
   the one that catches a mis-escaped chunk, so **do not** skip the
   round-trip: additionally assert `printExpr(after-node)` re-parses *and*
   that evaluating the template's chunks equals the cooked values. A cheap
   way: `new vm.Script("(" + printed + ")")` in try/catch plus, for T1 with
   all-literal substitutions, `eval`-free string comparison of the chunks.

**Semantics / D14.** The rewrite is exact, not approximate, and that is worth
stating because it is the rung's whole justification:

* `HermesInternal.concat(c0, s0, c1, …)` is ToString on every piece; a
  template literal's `TemplateStringsArray` substitution is `ToString(sub)`.
  Same operation, same order (left to right), same result — *including* for
  Symbols (both throw) and for objects with a `valueOf` (both give
  `"[object Object]"`). This is why the rewrite is legal where a `+` chain's
  would not be.
* Substitutions are neither reordered nor duplicated: the writer reuses the
  exact `Expr` nodes.
* `getTemplateObject` caches per call-site id and freezes the object; a
  recovered `` tag`…` `` gets the same per-site identity from the JS engine.
  Guard 5 in T2 is what keeps that a fact rather than a hope.
* `-O0` builds emit an `Add`/`AddS` chain instead (row 21's original reading).
  This rung then matches nothing, which is correct: the information is gone
  and no heuristic is allowed to invent it.

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `stage: "B"`, `after: ["expr-rebuild", "global-access"]`,
`before: ["var-naming"]`. `call-shape` provably refuses these sites
(`Reflect.apply(concat, "…", […])` fails R3a — `this` is not `undefined` — and
fails R3b — the receiver is not the callee's object), so the two rungs are
order-independent; assert that with a negative unit test in *both* passes
rather than an `after:` edge. Naming runs later so it never burns a name on a
register this rung deletes.

**Refuse (per-site, distinct reason strings):** `unresolved-concat`,
`dynamic-args`, `non-literal-chunk`, `no-substitutions`, `seq-argument`,
`unresolved-template-object`, `raw-cooked-mismatch`, `arity-mismatch`,
`shared-template-object`, `duplicated-site-id`, `interleaved-effect`,
`raw-does-not-cook`, `nested-template-object`.

**Fixtures (red→green).** `targets: ["43-template-literals",
"44-tagged-templates"]`, all five HBC versions plus `.min`/`.obf`. Unit tests
on hand-built lists (`tests/gate/passes/synth.ts`): ≥1 positive per rule
(odd `flat`, even `flat`, nested template, `dup:true`, `dup:false`); negatives
for a `+` chain (must not match), a computed chunk, a `concat` whose `this` is
a register with two writes, a `getTemplateObject` whose result is read twice,
two calls sharing one id; ≥1 site the `check` refuses.

**Corpus metric** (`tools/passes-metrics.ts`): share of emitted functions
containing zero `__hbc_HermesInternal.concat` and zero
`__hbc_b_getTemplateObject`. Baseline **0 %** free in `43`/`44`; **floor
≥ 90 %** over `tests/fixtures/constructs/**` at all five versions ×
base/`.min`/`.obf`, and **≥ 80 %** on the RN template bundle (Metro output has
`concat` sites inside functions this rung may legitimately refuse). Secondary
floor: zero fixture verdict moves, PL-09 holds, `--passes=none` byte-identical.
Every residual site carries a recorded reason; the histogram in
`docs/STATUS.md` is part of the deliverable.

**Estimated size:** ~180 lines across `match/rewrite/check`, ~40 lines of
`ast.ts`/`print.ts` (F14), ~220 lines of tests.

## 8. Open questions

1. **Row 21 rewrite.** Confirmed `-O` vs `-O0` split above is from decompiler
   output, not from a dump diff. The implementer must confirm at the
   `hermesc -dump-bytecode` level that the `-O0` form really is an `Add`
   chain and that nothing else in the pipeline (the emitter's own folding)
   produced the difference. If `-O0` also emits `concat`, row 21 is simply
   wrong rather than optic-dependent, and §0's table needs one fewer caveat.
2. **Does `concat` ever come from `String.prototype.concat` in app code?**
   The callee is `__hbc_HermesInternal.concat`, an internal namespace no app
   can name, so no — but confirm on the RN template bundle before trusting
   the ≥ 80 % floor.
3. `String.raw` is itself a tagged template; nothing here special-cases it and
   nothing should.
