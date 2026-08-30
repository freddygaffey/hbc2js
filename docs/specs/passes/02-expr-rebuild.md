# 02 — `expr-rebuild` (stage B, catalogue row **R1**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. The
framework it needs (`src/passes/ast.ts`, the stage-B driver, `ctx.fnBody`)
lands in `01-framework-fixes.md` first.

## 1. Purpose

The emitter prints one statement per instruction, so every value is a register
round-trip. This rung folds a register's value into the single place it is
consumed and deletes stores nobody reads. It is **first in stage B**
(`registry.ts` injects `after: ["expr-rebuild"]` into every other stage-B
rung, PL-11): no syntactic matcher can see through one-statement-per-instruction.

Before — `tests/fixtures/constructs/19-var-hoisting/v94.hbc`, `fn#1 "demo"`:

```js
r2 = r1.print;
r3 = undefined;
r0 = "x before declaration:";
r0 = Reflect.apply(r2, r3, [r0, r3]);
```

After:

```js
Reflect.apply(r1.print, undefined, ["x before declaration:", undefined]);
```

(`global-access` and `call-shape` then finish it into `print("x before
declaration:", undefined)`.)

## 2. Baseline shape

`src/emit/function.ts` declares the frame as `let r0, …, rN`; `src/emit/lower.ts`
emits `assign(R(dst), value)` per instruction, i.e. `{k:"expr", expr:{k:"assign",
target:{k:"ident", name:"rN"}, value: E}}`. Registers are reused aggressively —
on `02-while-loop` v94 `r8` is stored six times inside one block's run — so
**any rule requiring a register to be single-def over the whole function folds
almost nothing**; the deadness condition in §4 is what makes this rung pay.

## 3. AST shape the rung owns

Match/rewrite: `let`/`decl` of `rN` (read only), `expr` statements whose
expression is an assignment to `ident rN`, and any `Expr` containing
`ident rN`. **Must not touch:** statement *order* of anything impure, `try`
and loops as structure, `__pc`/`__exc`/`__state*`/`__sent`/`__isReturn`/
`__done` (they are ordered protocol effects, never registers), env slots
`_eD_S`, `_fnN`, `__hbc*`. Only names matching `/^r\d+$/` are registers.

## 4. Matcher

Site = one statement list `L` (`ctx.fnBody` reachable, innermost first). Return
the **first** applicable of R1a/R1b/R1c, capturing exactly one site per call.

Define *simple* statements as `k ∈ {expr, init, decl, comment}` — these cannot
transfer control. Define `mentions(s, rX)` as any `ident rX` anywhere in `s`,
including nested lists and nested `func` bodies.

**Deadness of `rX` after index `j` in `L`.** One of:

* **(D-a) rewritten in the run.** There is `k > j` with `L[k]` a plain store
  `rX = …` (target exactly `ident rX`); every statement in `L[i+1..k-1]` is
  simple; and no statement in `L[j+1..k-1]` mentions `rX`. Reads of `rX`
  elsewhere in the function are then irrelevant: they execute either before
  `L[i]` (unchanged — the store is only deleted, never moved earlier) or after
  `L[k]` has rewritten `rX`, and nothing between can observe the old value.
* **(D-b) single-use in the function.** `identUses(ctx.fnBody, rX)` reports
  exactly one write (at `i`) and one read (at `j`), and `nested === 0`.

Refuse if neither holds. Refuse whenever `identUses(...).nested > 0`
(a nested `func` captures the register).

**R1a — forward inline.** `L[i]` is `rX = E`; `L[j]` (`j > i`) reads `rX`
exactly once, in the *top-level* expression of a statement of kind `expr`,
`init`, `return`, `throw`, or in the `test` of an `if`/`while`/`do-while`/`for`
or the `disc` of a `switch` (never inside a body, never inside a nested `func`);
`rX` is dead after `j` (above); and the value may legally travel from `i` to `j`:

* if `isPure(E)`: every statement in `L[i+1..j-1]` is simple, `isPureStmt`,
  does not mention `rX`, and does not write any register `E` reads;
* else: `j === i + 1` (no intervening statement at all).

**R1b — dead store.** `L[i]` is `rX = E` and `rX` is dead after `i` (use `j =
i` in the deadness test). Refuse when `E` is `ident rX` (that is R1c).

**R1c — self-move.** `L[i]` is `rX = rX`. Always matches; always safe.

## 5. Writer

* **R1a**: delete `L[i]`; in `L[j]` replace the single `ident rX` with `E`.
  Never re-parenthesise — `src/emit/print.ts` owns precedence.
* **R1b**: if `isPure(E)` delete `L[i]`; else replace it with `{k:"expr",
  expr: E}` (the effect stays, the store goes).
* **R1c**: delete `L[i]`.

Nothing else in the list moves. The `let r…` declaration is **not** touched
here — `01`'s F10 finaliser prunes it after the whole stage-B pipeline.

## 6. Checker

Class: **expression-only** (ladder §4.3). `check` calls
`expressionOnlyCheck(before, after)` — `effectSequence` deep-equality plus "no
`rN` read before its def" — and then re-asserts what `rewrite` assumed:

1. the deadness branch it used still holds on `before` (recompute; do not trust
   captured data);
2. for R1a with impure `E`, `j === i + 1` in `before`;
3. for R1a with pure `E`, every skipped statement is `isPureStmt`, mentions
   neither `rX` nor any register `E` reads as a *write*;
4. `identUses(after, rX).reads` is exactly `identUses(before, rX).reads - 1`
   and `.writes` is one fewer;
5. `nested === 0` for `rX` in `before`.

The driver adds `parses(fnBody)` once per function (01 F1) and `checkBindings`
(EM-01) runs afterwards over the whole program.

## 7. Ordering, refusals, fixtures, metrics

**Ordering.** `stage: "B"`, first in `REGISTRY`'s stage-B block, no `after`;
every other stage-B rung gets `after: ["expr-rebuild"]` injected. **IR
ownership** as §3: never reorder an impure statement, never cross a
control-flow statement — a value travels only inside one straight-line run of
one list.

**Refuse (per-site abandonment, each with a distinct `reason` string):**

* `nested-capture` — a nested `func` mentions `rX`.
* `not-dead` — neither (D-a) nor (D-b).
* `impure-move` — `E` impure and `j > i + 1`.
* `input-clobbered` — a skipped statement writes a register `E` reads.
* `use-under-control-flow` — the only read is inside a body, not a test.
* `two-reads` — `L[j]` reads `rX` more than once (folding would duplicate an
  effect or an allocation).
* `protocol-name` — the target is `__pc`, `__exc`, `__state*`, an env slot, or
  anything not matching `/^r\d+$/`.
* `generator-frame` — the function is a v≤96 generator body (`ctx.cfg` says the
  function is a generator): registers there are restored across suspensions by
  `__hbc_makeGenerator`, so a "dead" store may be read after a resume.
  Refuse the whole function; `yield-recovery` (batch 4) revisits this.

**D14.** The rung moves only pure values and only forwards inside a
straight-line run, so evaluation order, TDZ traps and the shared-`let`
loop binding are untouched. It must never delete a `member` read (a getter is
an effect — `isPure` returns false for `member`, which is what forces that).

**Fixtures (red→green).** `targets: ["19-var-hoisting", "02-while-loop",
"01-if-else-chain"]`. Unit tests on hand-built lists
(`tests/gate/passes/synth.ts`): ≥1 positive per rule; negatives for
`two-reads`, `impure-move`, `nested-capture`; ≥1 site the `check` refuses.
Red→green at all five HBC versions plus `.min`/`.obf`.

**Corpus metric** (`tools/passes-metrics.ts`, 01): total `rN` identifier
occurrences over `tests/fixtures/constructs/**` at v94 must fall by **≥ 50 %**,
and median statements per emitted function by **≥ 35 %**, with 492/492 fixture
PASS unchanged and PL-09 (PASS with passes on *and* off) holding.

**Estimated size:** ~200 lines across `match/rewrite/check`, ~250 lines of
tests. The largest rung in batch 1 and the one to review hardest.
