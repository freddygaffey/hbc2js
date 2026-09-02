# 17 — `spread-rest` (stage B, catalogue row **23**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing
else. Batch 3; runs after `expr-rebuild`, `global-access`, `call-shape`,
`destructure`; before `var-naming`.

**Boundary with `destructure` (spec 16 §7, resolving P-9's overlap flag).**
This rung owns the three **helper-call** spread forms —
`__hbc_b_arraySpread`, `__hbc_b_copyRestArgs`, and **2-argument**
`__hbc_b_copyDataProperties` — plus the `__hbc_b_apply` that consumes a
spread-built argument array. It never touches destructuring's `...`: the
array-pattern rest is an inline iterator loop and the object-pattern rest is
the **3-argument** `copyDataProperties` form, both spec 16's. The
`copyDataProperties` argument count is the discriminator; assert it in
`match` *and* `check`, and carry a negative unit test built from the 3-arg
shape. Declared order: `after: ["destructure"]` — not a data dependency
(the matchers are shape-disjoint), but it makes the pipeline order a stated
fact and keeps this rung's residual-site metric honest (destructure has
already deleted the iterator-protocol runs that are not spreads).

## 0. Before you write code: row 23 is single-version

`docs/LOWERING-CATALOGUE.md` row 23 is `✅ single-version` (v94 only), which
PL-06 refuses. §2's shapes are confirmed in decompiler output at v94 and v99
(`40` emits 13 helper-call sites at v99, `41` emits 9 `copyDataProperties` at
v99, same shapes), but the implementer must re-read `hermesc -dump-bytecode`
for `40`/`41`/`42` at v94 and v99, put the v99 evidence in
`docs/lowering/spread-rest.md`, and flip the Confidence column to
`✅ verified` in the same commit as the pass. Row 23's note says the object
builtin index is version-dependent — the *emitter* already resolved that to
the `__hbc_b_copyDataProperties` name, so stage B is version-uniform; state
that in the evidence file.

## 1. Purpose

Turn the spread helper calls back into `...` syntax.

Before (`40-spread-array` v94 global, after batch-1 passes; v99 identical
shapes):

```js
r3 = [1, 2, 3];
r9 = [0];
r9.length = 3;
r2 = 1;
r1 = __hbc_b_arraySpread(r9, r3, r2);
r9[r1] = 4;
r9[__hbc_b_arraySpread(r9, r3, r1 + r2)] = 5;
…
r1 = new Array(0);
__hbc_b_arraySpread(r1, r3, 0);
r1 = __hbc_b_apply(r7, r1, undefined);
```

After:

```js
r3 = [1, 2, 3];
r9 = [0, ...r3, 4, ...r3, 5];
…
r1 = r7(...r3);
```

Rest parameter, before (`42-rest-params` v94/v99 `fn#1` `combine`):

```js
function _fn1(a1) {
  return "first=" + a1 + " rest=[" + __hbc_b_copyRestArgs(arguments, 1).join(",") + "] arguments.length=" + arguments.length;
}
```

After:

```js
function _fn1(a1, ...r0) {
  return "first=" + a1 + " rest=[" + r0.join(",") + "] arguments.length=" + arguments.length;
}
```

Object spread, before (`41-spread-object` v94/v99 global):

```js
r6 = {};
__hbc_b_copyDataProperties(r6, r1);
__hbc_b_copyDataProperties(r6, r2);
```

After:

```js
r6 = {...r1, ...r2};
```

## 2. Baseline shapes (measured, v94 and v99)

Read from decompiler output on `40`/`41`/`42` at both versions with
`--no-pass var-naming --no-pass fn-naming`. All four shapes are
version-uniform; the only v94/v99 difference observed is expr-rebuild
residue (how many single-use copies got inlined), which none of the rules
key on.

**H1 — `__hbc_b_arraySpread(target, source, startIndex) → nextIndex`.**
The emitter's helper appends `source`'s iteration to `target` starting at
`startIndex` and returns the next free index. Observed consumers:

* *(a) array literal with spread:* seed `rT = [c0, …]` (possibly followed by
  `rT.length = n` when Hermes pre-sized the buffer), then an alternating run
  of `rI = arraySpread(rT, s, idx)` and `rT[rI] = v` /
  `rT[arraySpread(rT, s, e)] = v` stores. Index expressions thread the
  returned value (`r1 + r2` with `r2 = 1`).
* *(b) spread-call argument array:* `rA = new Array(0)`, one or more
  `arraySpread(rA, sK, idxK)` (the first index literal `0`, later ones the
  previous call's result), no element stores, then exactly one
  `rR = __hbc_b_apply(fn, rA, thisV)`.
* *(c) iterable copy:* `rA = new Array(0); arraySpread(rA, src, 0);` and
  `rA` used as an ordinary array afterwards (`[...str]`, `[...a]`).

**H2 — `__hbc_b_apply(fn, argsArray, thisV)`.** Only observed consuming an
H1(b) array. `thisV` is `undefined` (a literal or an undefined-only register)
in every observed site — `f(...a)` has no receiver. `call-shape` does not
touch `__hbc_b_apply` (it is not in R3's callee list); this rung is its only
consumer.

**H3 — `__hbc_b_copyRestArgs(arguments, k)`.** `k` is an integer literal equal
to the function's declared parameter count (`combine`: `k = 1` with `a1`;
`restOnly`/`variadicSum`: `k = 0`, no declared params). The call appears
*inline* in an expression (it is not necessarily stored to a register —
`combine` chains `.join` straight off it).

**H4 — 2-argument `__hbc_b_copyDataProperties(target, source) → target`.**
`rT = {}` (or an object literal), then one call per spread in source order;
non-spread properties that follow a spread are plain member stores after the
call (`41`: `r5[r1] = r2` with `r1 = "size"` — the key may sit in a register);
non-spread properties *before* the first spread are inside the seed literal.
The call's result register is either ignored, dead (immediately overwritten),
or the target itself. Spreading `null`/`undefined` compiles to the same call
with that literal as `source` (a no-op at runtime, as in JS).

## 3. AST the rung owns

**May match/rewrite:** runs of sibling statements in one statement list that
form an H1(a)/H1(b)+H2/H4 unit; a single `copyRestArgs` call expression plus
the owning `func`'s parameter list (H3); the `new Array(0)` /object-literal
seed statements of a matched unit.

**Must not touch:** 3-argument `copyDataProperties` (spec 16's); the inline
iterator rest loop (spec 16's); `arguments` uses other than the matched
`copyRestArgs` first argument; `Reflect.apply`/`Reflect.construct` (they are
`call-shape`'s — by this point in the pipeline any survivor was *refused* by
call-shape and must stay); statements between unit members that the
preconditions below do not explicitly admit; any `__pc`/`__exc` write inside
a matched run (`pc-tracked-region`, as spec 16).

### Framework prerequisite: F15's `Param` record

Rest parameters need `func.params: readonly Param[]` with `rest?: true` —
the same framework change spec 15 §3 (F15) defines for defaults. If
`default-params` shipped first (it did — merged 2026-09-02), F15 exists;
verify `print.ts` actually emits `...` for `rest: true` (spec 15 shipped the
field speculatively) and that `scope-check`/`freeNames` bind the rest name.
Spread in *expression* position needs one new node:

```ts
| { readonly k: "spread"; readonly arg: Expr }   // valid only inside array
                                                 // literals, call args, and
                                                 // object literals
```

`print.ts` emits `...` + `expr(arg)` at assignment precedence;
`effectSequence` records a `spread` in an array/object literal or argument
list as **an iteration of `arg`** (ordered — it can run user code via
`Symbol.iterator`/getters) in the position it occupies; `parses` is the
backstop for a `spread` printed anywhere illegal. Object literals need their
property list extended to admit `{ k: "spreadProp", arg: Expr }` alongside
keyed properties.

## 4. Matcher

Site = one statement list `L` (H3 also reads `ctx.fnBody`'s owning `func`).
Rules in priority order; first match wins; all preconditions recomputed in
`check`.

**S1 — array literal with spread (H1a).** Anchor: a statement whose value
writes `rI = __hbc_b_arraySpread(rT, s, idx)` (or a store indexed by such a
call). Walk backwards to the seed: `rT = [.…]` (an array-literal `init`) with
an optional following `rT.length = n` store; walk forwards over the
alternating run. Preconditions:

1. The seed's elements and every stored element are recorded in index order;
   the index chain is *provable*: the first `arraySpread`'s `idx` equals the
   seed's element count (after the optional `.length` trim, which is dropped
   — it exists only to pre-size), each store's index is the previous call's
   result register (or that register `+ 1` after a store), and each later
   call's `idx` continues the chain. Any index expression the chain cannot
   prove → refuse (`index-chain-broken`).
2. Between unit members only statements that are `isPureStmt` and write no
   register the unit reads (`interleaved-effect` otherwise).
3. `rT` is not read between the seed and the last unit member except by the
   unit itself (`target-escapes`); intermediate index registers are dead
   after the run (`defUse`).
4. Every spread `source` expression is reused by reference; a `source` that
   is `rT` itself → refuse (`self-spread`).

→ `{ target: rT, elements: [lit…, spread(s), lit…, …] }`.

**S2 — spread call (H1b + H2).** Anchor: `rR = __hbc_b_apply(F, rA, T)`.
Walk backwards collecting `arraySpread(rA, sK, idxK)` calls and
`rA[i] = v` stores (mixed spread/plain argument lists) down to the seed
`rA = new Array(0)`. Preconditions: 1–4 above on the argument chain, plus:

5. `T` is literal `undefined` or an undefined-only register
   (`this-not-undefined` otherwise — `f(...a)` has no receiver; a receiver
   would need `F.call(T, ...)` shape, not observed, §8 Q2).
6. `rA` has no use after the `__hbc_b_apply` (`args-array-escapes`).
7. `F` is a register or expression whose evaluation the rewrite does not
   reorder past an effect (it moves from before the seed run to the call
   position only if every intervening statement is pure w.r.t. it —
   otherwise `callee-order`).

→ `rR = F(...args)` shape.

**S3 — rest parameter (H3).** Anchor: any expression
`__hbc_b_copyRestArgs(ARGS, K)` inside the current function's body.
Preconditions:

8. `ARGS` is the `argumentsObject` node; `K` is an integer literal equal to
   `F.params.length` counting only non-rest params (`rest-index-mismatch`
   otherwise — after `default-params` grew the list, defaulted params count).
9. This is the **only** `copyRestArgs` call in `F`'s body
   (`multiple-rest-reads`): each call returns a *fresh* array, so two calls
   are two arrays with separate identities and cannot both become one `...r`
   binding. (One call = one fresh array per invocation = exactly a rest
   parameter's semantics, mutations included.)
10. `F.params` has no `rest` entry yet, and `F` is not the module wrapper.

→ append `{ name: fresh, rest: true }` to `F.params` and replace the call
expression with `ident(fresh)`. `fresh` is the register-protocol name
`r{maxRegisterIndex + 1}` so `var-naming` treats it like any register; it must
not collide with `freeNames(F)` (assert, don't assume).

**S4 — object spread (H4).** Anchor: a statement-position 2-argument
`__hbc_b_copyDataProperties(rT, s)`. Walk back to the seed
(`rT = {}` or `rT = {lit…}`), forward over further 2-arg calls on `rT` and
literal-key member stores to `rT`. Preconditions 2–3, plus:

11. Argument count is exactly 2 (`destructure-rest-form` — the 3-arg form is
    spec 16's).
12. Each call's result register is unused, dead before its next write, or
    `rT` itself (`result-escapes`).
13. A member store folded into the literal must have a provable string key
    (literal, or a register whose single write is a string literal); stores
    the walk cannot prove end the unit *before* them (a prefix is a valid
    smaller match here — later stores simply stay as stores after the
    literal, order preserved).

→ `rT = { seedProps…, ...s1, key: v, ...s2, … }` in observed order.

**Idempotence (PL-08).** Structural: the rewrites contain no
`__hbc_b_arraySpread`/`__hbc_b_apply`/`copyRestArgs` and no 2-arg
`copyDataProperties`, so every rule's anchor fails on its own output; S3
additionally re-refuses via precondition 10.

## 5. Writer

* **S1/S4** — replace the seed statement's value with the rebuilt literal
  (array elements / object properties in recorded order, `spread` nodes
  wrapping the *reference-equal* source expressions); delete the helper
  calls, the `.length` trim, and the folded stores.
* **S2** — replace the `__hbc_b_apply` statement's value with
  `call(F, args)` where `args` mixes `spread` nodes and plain elements in
  chain order; delete the seed and the `arraySpread`/store run.
* **S3** — parameter-list edit + expression substitution as §4; nothing else
  in the body moves. Drop the fresh name from no `let` (it was never
  declared); prune dead `let` entries for registers the other rules freed
  (spec 16 §5's `pruneRegisterDecls` note applies).

## 6. Checker

Class: **expression-only** (ladder §4.3), **recompute-and-diff**: rebuild the
helper-call form from `after` and diff effect sequences against `before` —
never trust match data.

1. **Canonical expansion.** `expand(afterUnit) → Stmt[]`: for an array/call
   unit emit seed, then per element in order — plain element: indexed store;
   spread: `arraySpread(target, source, idx)`; for S2 finish with
   `__hbc_b_apply(F, rA, undefined)`; for S4 emit seed + one 2-arg
   `copyDataProperties` per `...` + one store per folded key. Require
   `effectSequence(expand(after))` deep-equals `effectSequence(matched run in
   before)`. This is where a reordered spread source, a dropped element, or a
   receiver smuggled past S2.5 fails honestly. (`effectSequence` must model
   `arraySpread`/`copyRestArgs`/2-arg `copyDataProperties` as
   calls-with-iteration — they run user code; that is F-framework work, keep
   it in `ast.ts`.)
2. Recompute every §4 precondition against `before`.
3. Reference-equality: every spread source and plain element in `after` is
   the same node observed in `before` — the rung never rebuilds operands.
4. S3: `after`'s params = `before`'s + exactly one `rest` entry at the end;
   `identUses(after.body, fresh)` reads equal `before`'s `copyRestArgs`
   call-site count (1); `arguments` uses other than the rewritten call are
   untouched (`42`'s `arguments.length` and `arguments[0]` sites must
   survive byte-identical).
5. Run-shape accounting as spec 16 §6.3 (one statement in, `n` out, flanks
   reference-equal).
6. The driver's `parses(fnBody)`.

**D14 / semantics.** Exact equivalences, each an acceptance condition:

* **`arraySpread` is iteration.** The helper iterates `source` with the
  iterator protocol, appending — precisely what a `...` element in an array
  literal or argument list does, in the same position and order. Precondition
  1's index-chain proof is what guarantees no element is silently reordered
  or double-counted.
* **`f(...a)` evaluates** `f`, then builds the argument list by iterating `a`,
  then calls with `this = undefined`. S2's preconditions 5–7 map each of
  those; a receiver or an escaping args array falls back to the helper form,
  which is correct output, merely unreadable.
* **Rest parameter**: fresh array per call, mutations local, `arguments`
  unaffected. One `copyRestArgs` call = same observable behaviour
  (precondition 9). `arguments` is unmapped at every Hermes version *and* in
  any JS function with a rest parameter, so aliasing cannot diverge —
  `42`'s `mutateParamAffectsArguments` is the regression canary and must
  keep its verdict. `f.length` ignores the rest param in JS and `paramCount`
  never counted it (spec 15 §2's table) — the rewrite moves toward ground
  truth.
* **Object spread** = `CopyDataProperties`: own-enumerable read in source
  order, later-key-wins, getters observed, `null`/`undefined` no-ops. The
  folded literal preserves exactly that order (S4.13 stops at anything it
  cannot prove).

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `stage: "B"`, `after: ["expr-rebuild", "global-access",
"call-shape", "destructure"]`, `before: ["var-naming"]`. The `destructure`
edge is declared-order hygiene, not data flow — see §0 and spec 16 §7's
ownership table (kept in one place there; this spec's copy is the summary).

**Refuse (per-site, distinct reason strings):** `index-chain-broken`,
`interleaved-effect`, `target-escapes`, `self-spread`, `this-not-undefined`,
`args-array-escapes`, `callee-order`, `rest-index-mismatch`,
`multiple-rest-reads`, `destructure-rest-form`, `result-escapes`,
`pc-tracked-region`.

**Fixtures (red→green).** `targets: ["40-spread-array", "41-spread-object",
"42-rest-params"]`, all five HBC versions plus `.min`/`.obf`. Unit tests on
hand-built lists: positives for H1a with two spreads and interleaved
elements, H1b single- and multi-spread, `[...str]` copy, `copyRestArgs` at
`k=0` and `k=1`, H4 with seed props, trailing stores and `null` spread;
negatives for a 3-arg `copyDataProperties` (must not match), spec 16's
iterator rest loop (must not match), a broken index chain, two
`copyRestArgs` calls in one body, an `__hbc_b_apply` with a defined `this`;
≥1 site the `check` refuses.

**Corpus metric** (`tools/passes-metrics.ts`): count of
`__hbc_b_arraySpread` + `__hbc_b_apply` + `__hbc_b_copyRestArgs` + 2-arg
`__hbc_b_copyDataProperties` occurrences in printed output. Baseline: 13
in `40`, 9 in `41`, 3 in `42` per version. **Floor: ≥ 90 % removed** across
`tests/fixtures/constructs/**` at all five versions × base/`.min`/`.obf`,
and **≥ 70 %** on the RN template bundle (Metro's own helpers may hold the
array in ways S1–S4 rightly refuse). Zero fixture verdict moves; PL-09
holds; `--passes=none` byte-identical; residual reasons histogrammed in
`docs/STATUS.md`.

**Estimated size:** ~300 lines across `match/rewrite/check`, ~60 lines
framework (`spread` node + printer + `effectSequence`), ~280 lines of tests.

## 8. Open questions

1. **`new C(...a)`.** Spread-new presumably lowers through
   `Reflect.construct` or a helper; no fixture covers it. Add a construct
   fixture (`build.sh` all versions) before extending S2 — until then
   whatever shape it takes is refused by anchor mismatch, which is safe.
2. **Method spread-call `o.m(...a)`.** Would surface as `__hbc_b_apply(F, rA,
   rO)` with a receiver; S2.5 refuses. If the RN bundle shows it, the sound
   rewrite is `F.call(rO, ...args)` only when `F` is provably `rO.m` — spec
   the extension with its own evidence, do not loosen 5 speculatively.
3. **`arraySpread` on a pre-sized seed** — the `.length = n` trim (§2 H1a) is
   deleted on the assumption it only pre-sizes; confirm at the dump level
   that the trailing-hole case (`[0, ...a]` where the seed literal was
   `[0, , , ]`) cannot leave observable holes the trim was masking. If it
   can, the trim's `n` must be checked against the rebuilt element count.
