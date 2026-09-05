# 27 — `iife-reconstruct`: putting an inlined IIFE back

Owner: `src/emit/iife-reconstruct.ts`. Landed 2026-09-05 (`agent/iife-reconstruct`).
Ruling: `docs/PUSHBACK.md` P-41 (default-on, not opt-in).
Repro: `tests/fixtures/constructs/75-sibling-envs`, `tests/gate/emit/sibling-env-slots.test.ts`.
Background: `docs/reports/2026-09-05-sibling-envs.md`.

## 1. The idiom

`hermesc -O` splices an immediately-invoked function expression into its
caller but keeps the callee's OWN environment. A caller that inlined several of
them therefore ends up with several environments SIDE BY SIDE, all children of
the same scope — fixture 75 compiles to `CreateFunctionEnvironment` of 2, 1 and
3 slots in one function, and react-navigation-example module 681 / fn#683 has
thirteen. Block scopes cannot produce this: hermesc merges sibling block scopes
into the enclosing function environment (P-41's evidence). Inlining is the only
trigger, and an IIFE is the only source form that round-trips it.

## 2. What the step does

The emitter declares every environment a function owns as one flat
`let _e<env>_<slot>` list in the function's top scope, so a recompile gives
hermesc a single scope and one renumbered environment. For each owned
environment that passes every guard in section 4, this step instead:

1. removes that environment's slot names from the flat `let` prologue;
2. moves the hoisted `function _fn<n>` declarations that read only that
   environment out of the prologue;
3. replaces the contiguous run of body statements that mention the
   environment (its statement RANGE) with

       (function () {
         let _e<env>_0, _e<env>_1, ...;
         function _fn<n>() { ... }
         ...the range...
       })();

4. hoists any `let` declared inside the range and read after it to a bare
   `let` immediately in front of the IIFE, leaving a plain assignment in place
   (fixture 75's `let r0 = undefined;` is the shape this exists for).

## 3. Why emit-side and not a stage-B rung

Two inputs decide the transform and neither survives into `src/passes`:

* the env graph — which `_e<env>_<slot>` names belong to one environment, and
  which environment is the PARENT of which (a parent is the function's own
  scope, never an inlined callee's);
* `closureCreationSites` / the emitter's hoisted-children list — whether a
  `function _fn<n>` in the prologue is a real child of this body or one this
  body only HOSTS for someone else (`src/emit/placement.ts`).

A rung would have to re-derive environment ownership from name spelling and
could not tell a hosted orphan from a child at all; moving a hosted orphan into
a wrapper makes its name unbound in the sibling that reads it
(`E_UNBOUND_IDENT`, measured: 227 functions lost before the guard existed).
The step is therefore a placement step in `src/emit`, run on the assembled
statement list at the end of `emitFunction`, before the AST passes.

## 4. Refusal table

Every refusal leaves the flat `let _e<env>_<slot>` prologue exactly as it was,
so refusing is never a behaviour change. Counts are per environment on
react-navigation-example-0.85.3 v98 (`--lenient-env`), 128 environments in 54
functions wrapped.

| Reason | Guard | rnav count |
|---|---|---|
| fewer than two owned environments | one environment IS the function's own scope; the flat prologue already round-trips it | not counted |
| `generator body` | a lowered generator's statements live in a re-entered same-frame closure | 0 |
| `no env-slot prologue` / `env-slot prologue shared with other names` | the `let` list could not be split cleanly | 0 |
| `parent of a sibling environment` | this environment is the parent of another owned one, so it is the function's own scope | 42 |
| `closure spans two environments` | a hoisted closure reads two of the function's environments; it can live in only one wrapper | 138 |
| `hosted closure cannot move into the range` | a closure that reads this environment is not created exactly once by this body (an orphan or a per-creation-context copy), so another function names it | 262 |
| `moved closure named from outside the range` | a closure that stays outside names one that would move in | 0 |
| `overlapping statement ranges` | two environments interleave, so neither is a contiguous run | 757 |
| `environment read outside the range` | a slot, or a sibling environment's slot, is touched outside the range — the wrapper would add a scope level to the parent chain (`diff:GetParentEnvironment/...`) | 75 |
| `return` | a `return` inside the range would return from the wrapper | 11 |
| `break out of range` / `continue out of range` | the target loop, switch or label is outside the range | 0 |
| `this` / `arguments` | rebound by the wrapper | 8 / 4 |
| `yield` / `await` | the wrapper is not a generator or async function | 0 |
| `raw text` | unanalysable statement | 0 |
| `var declared in the range` | `var` is function-scoped; the wrapper would change its scope | 0 |
| `<kind> declaration outlives the range` | a `const`/`function`/`class` declared inside is read after it and cannot be hoisted | 0 |

## 5. Tests

* `tests/gate/emit/sibling-env-slots.test.ts` — decompile fixture 75, recompile
  with hermesc v98/v99, assert the sizes of the environments created in the
  owning function and the slot immediates every reader loads are the original's.
  Both cases were skipped under P-41 and are green with this step.
* `tests/gate/emit/iife-reconstruct.test.ts` — structural: fixture 75 emits
  three IIFEs at v98/v99 and none at v84/v94/v96 (those versions do not inline);
  the flat prologue is gone; every guard in section 4 refuses on a synthetic
  statement list.
* `tests/gate/decompile/equivalence.test.ts` (T2) covers behaviour.

## 6. Measurement

`node tools/e2e/roundtrip-corpus.ts --only react-navigation-example-0.85.3 --passes on`,
same worktree, before -> after:

* IDENTICAL 6184 (42.83%) -> 6214 (43.04%) of 14437
* `diff:LoadFromEnvironment(imm)` 867 -> 804
* `diff:CreateFunctionEnvironment(imm)` 619 -> 616
* 31 functions newly IDENTICAL, 1 newly DIFFERENT (bucket
  `diff:LoadConst/GetGlobalObject`; recorded in the `docs/BUGS.md` row).

## 7. Not done

`overlapping statement ranges` is by far the largest refusal (757). Module 681 /
fn#683's thirteen environments are in it: their statements interleave because
the emitter places each environment's stores where the bytecode had them rather
than grouping them. Grouping would need a reordering argument of its own and is
not attempted here.
