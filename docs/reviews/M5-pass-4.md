# Review — M5 pass 4: `call-shape` (row R3)

**Scope.** Commit `f61fdfc` (implement `call-shape`) plus `371c678` (scope-aware
`identUses` relaxation lifting the clean-function metric to 65.7%). Files:
`src/passes/call-shape/{match,rewrite,check,index}.ts`, spec
`docs/specs/passes/04-call-shape.md`. Review-only on `src`; no edits made.

**Verdict: FIX-THEN-MERGE** — one soundness gap in R3c's guard (H1, below),
fixable in one line + one regression test. Every other rule is sound, the
corpus output is correct and markedly more readable, and STATUS's metric is
honest.

---

## 1. Is the recompute-and-structurally-compare check a sound substitute? (scrutiny item 1)

The check (`check.ts`) deliberately does **not** call `expressionOnlyCheck`. Its
own block comment is correct about *why*: `effectSequence` visits a call's callee
before pushing the call entry, so `Reflect.apply`'s own `.apply` member-read (and
R3d's gained `.call`/`.apply` read) counts as a real effect, and a byte-for-byte
sequence diff would refuse every correct rewrite this rung makes, in both
directions. So the substitute strategy is *necessary*.

The substitute is: recompute the site from `before` alone
(`recomputeSite` → `collectCandidates` + `classifyNode`, never touching captured
`match` data), assert every non-matched statement is byte-identical, and assert
the matched statement equals `applyReplacement(before[i], target, replacement)`
— the same pure builder `rewrite.ts` uses. **This reduces the check's soundness
entirely to `classifyNode`'s per-rule soundness**: the check confirms the rewrite
did exactly what `classifyNode` dictates and touched nothing else, but it does
*not* independently re-derive semantic equivalence. That is an acceptable design
*iff* every `classifyNode` rule is individually sound. I audited all four against
the reviewer's named attack vectors:

| Vector | Rule | Verdict |
|---|---|---|
| receiver evaluated twice | R3b requires `O.k==="ident"` (`match.ts:162`) — a nested-member receiver (`a.b.c(x)`) is refused `unproven-this`, never double-evaluating `a.b`. Evaluating an *identifier* twice is free. | **sound** |
| arg side-effect reordered vs callee | Callee `F` is always the first observable effect in both forms; args follow in source order; the dropped `Reflect.apply` read and `undefined` eval are side-effect-free. Verified for R3a/R3b/R3d incl. computed-member callees (the computed `[p]` sub-expression is reused *by reference*, so its effect stays in place). | **sound** |
| `.apply` with a non-array spread | R3a/R3b/R3c refuse a non-`k:"array"` operand or any `k:"seq"` element (`extractArgsArray`) → `dynamic-args`. There is no spread *element* kind in the AST at all (`src/emit/ast.ts:29`). R3d passes `arr` through by design (`.apply` takes it as a value). | **sound** |
| getter as the callee | Sound for R3a, R3b, R3d, and the **2-arg** R3c — the getter fires once in both baseline and rewrite, in the same order. **UNSOUND for the 3-arg R3c** — see H1. | **gap** |

`this`-binding is preserved throughout: both `Reflect.apply(F, undefined, …)` and
`F(…)` pass `undefined` as the this-argument, and the callee's own strictness does
the (identical) coercion — so caller strict/sloppy is irrelevant. R3b/R3d pass the
receiver explicitly and unchanged.

### H1 (HIGH — guard soundness; not corpus-reachable today). R3c drops one evaluation of a getter callee in the 3-argument form.

`classifyReflectConstruct` (`match.ts:173-183`) accepts a **member** callee `C`
via `isSimpleCalleeChain`, and for the 3-arg form only checks
`JSON.stringify(NT) === JSON.stringify(C)`. So `Reflect.construct(a.b, [x], a.b)`
classifies `ok: R3c → new a.b(x)`. I confirmed this against the real code with a
hand-built AST:

```
classifyNode( Reflect.construct(a.b, [x], a.b) )
  → { ok:true, rule:"R3c", replacement: new a.b(x) }
```

`Reflect.construct(target, args, newTarget)` evaluates `target`, then `args`, then
`newTarget` — so the baseline evaluates `a.b` **twice**; the rewrite `new a.b(x)`
evaluates it **once**. If `b` is a getter (or `a` a Proxy) with a side effect,
the observable behaviour changes (fires once, not twice). The substitute check
**passes this** — it recomputes `classifyNode`, gets the same verdict, and agrees
— so `check` is *not* the sound backstop its block comment claims to be for this
one shape. Since stage B has no semantic round-trip (only `parses`), nothing else
catches it either.

**Reachability today: none.** The emitter emits the 3-arg form only for
`CallWithNewTarget`/super (`lower.ts:276`) with `C` and `NT` as *registers*, and
there `NT !== C` (parent constructor vs derived new.target) so R3c refuses
`explicit-new-target` — confirmed on `33-class-inheritance-super` v99 (lines 52,
140 correctly left as `Reflect.construct`). For `NT===C` to be a member, a 2-use
register would have to be inlined into both slots, which `expr-rebuild` (single-use
inliner) will not do. So this is a **latent guard hole**, exactly the flavour of
"latent, not corpus-triggered" that `expr-rebuild`'s H1 was — but the emitter is
not frozen and `expr-rebuild`'s heuristics evolve, and the whole selling point of
this bespoke check (that it is a *sound* substitute for `expressionOnlyCheck`) is
what fails here.

**Fix (`match.ts`, `classifyReflectConstruct`, ~line 181):** when `NT !== undefined`,
after the identity check, require `C.k === "ident"` (a register/ident is free to
evaluate twice; the real emitter always has one here, so this costs zero corpus
coverage). Otherwise refuse (reuse `impure-callee`, or a new
`duplicated-construct-callee`). One line, one branch. Because `check` recomputes
`classifyNode`, the same edit fixes match *and* check.

**Regression test to request (`call-shape.test.ts`):** a
`Reflect.construct(a.b, [x], a.b)` case (member callee, duplicate new-target) must
`classifyNode → {ok:false}` / `match → null`. The existing "identical new-target"
test (`call-shape.test.ts:132`) uses `id("r2")` — the *safe* register case — so
this shape is currently untested.

## 2. R3b double-evaluation and R3c new-target (scrutiny item 2)

Both **confirmed sound**:

- **R3b never turns `a.b.c(x)` into a double-eval of `a.b`.** `sameIdent` requires
  `O.k === "ident"` (`match.ts:162`); a member `O` (`a.b`) fails it and, being
  neither the literal `undefined` nor a proven-undefined register, falls to
  `unproven-this`. So `Reflect.apply(a.b.c, a.b, [x])` is refused, never rewritten.
- **R3c refuses a distinct `new.target`.** `match.ts:181` refuses
  `explicit-new-target` unless `NT` is `JSON.stringify`-identical to `C`. Verified
  on the corpus: `33-class-inheritance-super` v99 leaves both super constructs
  (`Reflect.construct(r2,[r4],r3)`, `r3≠r2`) untouched while rewriting the plain
  `Reflect.construct(r7,[r12,r11]) → new r7(r12, r11)`.

## 3. Output correctness & readability, passes ON vs `--passes=none` (item 3)

Ran `node src/cli.ts <hbc>` vs `--passes=none`:

- **`21-iife-closures` v94**: `Reflect.apply` **11 → 1**. Rewrites are clean method
  and plain calls (`r4.value()`, `r4.increment()`, `r6("initial:", r5)`), and the
  now-dead `this`-holding registers (`r1 = undefined`) fall to later DCE
  (`let r0, r1; r1 = undefined;` → `let r0;`). The one residual
  `Reflect.apply(r4, r1, [r3])` is correctly refused (`r1` is a real receiver, not
  a proven-`undefined` this, and `r4` is not a member so R3b cannot apply).
- **`33-class-inheritance-super` v99**: `Reflect.construct` **4 → 3**
  (`new r7(r12, r11)` recovered; two super triples correctly kept), `Reflect.apply`
  **9 → 4**; the `Array.prototype.slice.call(...)`-args and distinct-new-target
  sites correctly refused.
- **bundle** functions with many calls: same shape, `Reflect.apply` collapsing to
  direct/method calls; no incorrect rewrites observed.

More readable, and every residual carries a recorded refusal reason — sound.

## 4. Device D16a (item 4): **INCONCLUSIVE — device busy.**

`adb devices` shows `HA2APYTS` in `device` state, **but** a
`tools/device-roundtrip.sh --variant js` roundtrip is already in flight (PIDs
42562/43775; `node src/cli.ts` decompiling an extracted bundle at ~99% CPU; a
gradle 8.0.1 daemon live). Per the brief, I did **not** launch a second roundtrip
against the same tablet (it would collide on install/launch/`uiautomator`).
Result: **INCONCLUSIVE** for batch 4. (The batch-4 rungs are stage-B AST rewrites
that pass the same `parses`/round-trip guards as batches 1–3, which did pass
on-device at 0.0000% — so no specific device risk is suspected; this is a
scheduling collision, not a signal.)

## 5. Metric honesty vs STATUS (item 5): **honest.**

STATUS (lines 40, 44) claims **65.7%** of 1,112 emitted functions free of
`Reflect.apply`/`Reflect.construct` (up from 64.2% after the `identUses` fix),
floor 63, and explicitly states this is **short of the spec's 95%/90% targets**,
naming the structural reason (residual real receivers / dynamic-arg shapes). The
`call-shape-metrics.test.ts` floor guard runs green (bundle metric is sweep-tier,
skipped in gate). No overclaim.

## 6. Gate status (context, not owned)

`npm test`: **1190/1194 pass, 4 fail.** None implicate `call-shape`:
1. `parse/fuzz.test.ts:53` — parse-layer mutant fuzz, unrelated layer.
2. `expr-rebuild.test.ts:327` "v94 shape: 19-var-hoisting fn#2" — a stale
   exact-string shape assertion, pre-existing (commit `789823c`; design debt
   already logged in STATUS line 45).
3–4. `imports.test.ts` — both from the concurrent **fn-naming** WIP (the reviewer's
   brief says to ignore `src/passes/fn-naming/**`): a missing
   `tests/gate/passes/fn-naming.test.ts`, and an import-boundary *false positive*
   where the test's `importsOf` regex matches the prose
   `from "a valid identifier that happens to be reserved"` in
   `fn-naming/match.ts:52`. Neither is a `call-shape` defect. (Worth flagging to
   the fn-naming owner: that boundary regex is over-greedy across comment text.)

---

### Requested actions
1. **[H1] Fix** `classifyReflectConstruct`: refuse the 3-arg form unless `C.k==="ident"`.
2. **[H1] Add regression test**: `Reflect.construct(a.b, [x], a.b)` must refuse.
3. Re-run D16a for batch 4 once the tablet is free (record both RMSE numbers).
