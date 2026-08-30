# Review: M5 passes #2 & #3 — `expr-rebuild` (903e884..466ccf3) + `global-access` (aec3888, f70f5bd)

Reviewer: Claude Opus 5, 2026-08-30. Scope: `src/passes/expr-rebuild/**`,
`src/passes/global-access/**`, `src/emit/scope-check.ts`, `src/passes/ast.ts`'s
`effectSequence`/`expressionOnlyCheck`/`isPure`, specs 02/03, STATUS/catalogue metrics.
Review-only on `src` — no `src` edits made; the one fix and one regression test named below
are proposed, not applied. The concurrent `src/passes/call-shape/**` work and its test churn
were ignored.

Method: re-ran the full gate (`npm test`) and the two passes' gate files directly; re-measured
the corpus with `tools/passes-metrics.mjs` rather than trusting STATUS; read the recovered JS for
`04-for-loop-basic`, `47-typeof-instanceof-in`, `19-var-hoisting` (many temporaries) and
`01-if-else-chain.obf` with passes ON vs `--passes=none`; verified the global-access
`KNOWN_GLOBALS` cap directly against `scope-check.ts`; built hand-made ASTs to try to make a
rewrite pass `check` and change semantics — one succeeded (H1); ran the D16a device round-trip on
tablet `HA2APYTS` with passes ON.

---

## `expr-rebuild` (row R1): **FIX-THEN-MERGE**

The output I read is correct on every fixture, the two implementer-flagged bugs are genuinely
fixed (cross-site read counting via `isDeadAfter`'s `readsAtJ`; self-referential store via the
read-before-plain-store ordering in `stmtVerdict` + the `isPlainStoreTo(list[j])` fast path — both
have the shape they claim and the `.obf` oracle now passes them). But the adversarial probe found a
**new** unsoundness the `check` does **not** catch, in the same deadness/legality area.

### H1 (HIGH) — R1a folds a pure value into a loop test that re-executes, without proving the value is loop-invariant

`match.ts:56-79` `topLevelExprOf` returns the `test` of a `while`/`do-while`/`for` as a valid R1a
read site (spec 02 §4 lists it explicitly). But a loop test is a **multiply-executed** position:
folding a pure `E` there replaces a single pre-loop snapshot with a per-iteration re-evaluation.
R1a's travel-legality (`match.ts:370-379`) only checks the statements **between** `i` and `j`; it
never checks that `E`'s input registers are left alone by the loop **body** that re-executes after
`j`. When the body writes a register `E` reads, the folded expression's value drifts across
iterations and semantics diverge.

Reproduced through the real driver (`applyAstPasses`, not just match/check in isolation — fires,
zero abandonments):

```
before:  r1 = 5; r0 = r1 + 0; while (r0) { r1 = r1 - 1 }     // r0 == 5 forever -> infinite loop
after:   r1 = 5;             while (r1 + 0) { r1 = r1 - 1 }   // r1+0 hits 0 -> exits after 5 iters
check:   { ok: true }
```

Why `check` misses it: `expressionOnlyCheck` compares `effectSequence`, but a pure `bin`/`ident`
contributes no effect and a plain-register assign is invisible (`effectSequence`,
`ast.ts:858,896`), so both sequences are empty and equal. The "read before first def" clause is
dodged whenever `r1` has an earlier def in the same list (as here) — that clause caught the
*naive* form (`r1`'s only def in the loop body) but not this one. `identUses` counts the test as
one syntactic read, so D-b ("single write, single read") is satisfied and R1a fires.

Not corpus-triggered today (hence the green gate): real Hermes loop lowering recomputes the
condition register inside the loop, giving it multiple defs and defeating D-a/D-b — the same
"stage B has no CFG" class the implementer already flagged for the two fixed bugs. It is latent,
and the `check` is supposed to be the backstop that makes `match`'s over-eagerness safe; here it
is not.

**Concrete fix** (`src/passes/expr-rebuild/match.ts`, R1a branch ~line 363-390): when `list[j]` is
a `while`/`do-while`/`for` and the matched read lives in its `test`, refuse (a new reason, e.g.
`loop-variant-input`) unless every name in `namesReadBy(value)` is written **nowhere** in that
loop's body (reuse `identUses(loop.body, name).writes === 0`, or simply refuse whenever `value`
reads any register and `j` is a loop test — the conservative choice, costing only the rare truly
loop-invariant snapshot). The same guard must be mirrored in `check.ts` (it re-derives via
`classifySite`, so fixing `classifySite` fixes both).

**Regression test to request** (`tests/gate/passes/expr-rebuild.test.ts`, negative case): the
`before` above must produce `match(...) === null` (or `classifySite(...).ok === false` with the new
reason). Ideally also a positive control — the same shape with a body that does **not** write `r1`
(e.g. `r2 = r2 - 1`) should still fold — and, best, a red→green trace-oracle construct fixture
`XX-loop-invariant-cond` exercising `let x = a + 0; while (x) { a-- }`, since only the `.obf`/trace
tier catches this class (the implementer's own note that expr-rebuild's unit tests never run the
oracle applies here too).

### Otherwise correct

- Impure-`E` reordering (`E` impure, folded past another impure subexpression of `L[j]`) *is*
  caught — impure effects are visible in `effectSequence`, so `expressionOnlyCheck` rejects it.
- Protocol names (`__pc`/`__state0`/`__exc`), env slots and generator frames are refused as
  specced; confirmed on `01-if-else-chain.obf` (state-machine left untouched).
- R1b keeps an impure value's effect in place (`{k:"expr",expr:value}`), no reordering.

---

## `global-access` (row R2): **MERGE**

The `KNOWN_GLOBALS` cap claim is **verified and correct**. `src/emit/scope-check.ts:16-46`'s
`checkBindings` (EM-01) runs unconditionally after every stage-B pass and throws `E_UNBOUND_IDENT`
for any bare identifier not declared in scope and not in its intrinsics-only allowlist. The pass's
entire idiom (`globalThis.print` → `print`) produces exactly such a bare identifier, so without a
gate it would crash `decompile()`. The rung's `isUnboundInEmittedScope` (`match.ts:273`) copies
that allowlist verbatim and refuses (`unbound-in-emitted-scope`) any name not on it, in **both**
`match` and `check` — so it correctly **refuses `print` rather than emitting a crash**. Read
directly in the emitted JS: on `04-for-loop-basic` and `47-typeof-instanceof-in` with passes ON,
`print`'s guard + `r6.print` read stay verbatim, while `47`'s `Object`/`Array`/`Symbol` guards
fold to bare identifiers. The gate test "Object/Array/Symbol guards fold, print's do not" asserts
exactly this at all five versions.

The queued fix (STATUS line 42) — widen `checkBindings` to accept any non-reserved, non-synthetic
bare identifier the decompiler deliberately emitted for a proven global — **is the right layer**.
The crash originates in `src/emit`, which D12a puts out of a pass's reach, and there is no
`EmitOptions`/`Pass` hook to extend the allowlist; the conservative pass-level refusal is the only
correctness-preserving move available to the rung, and lifting the cap belongs to whoever owns
`src/emit`. A pass-level workaround (emitting a bare global the emitter then rejects) would be
strictly wrong. No change requested in this rung.

Guard-shape recognition, the §4 first-`globalThis`-write global proof (with its documented,
tested widening), the writer, and the §6 effect-normalised checker all match the spec. The
`DeclareGlobalVar` idiom is structurally unmatchable by `recognizeGuard`, so §7's required refusal
is automatic. No findings.

---

## Metrics honesty

Re-measured with `tools/passes-metrics.mjs`:

| metric | STATUS | measured now |
|---|---|---|
| expr-rebuild `rN` reduction | 21.0% (12285→9711) | **20.6% (12139→9635)** |
| expr-rebuild median stmts/fn | 16.7% (12→10) | **16.7% (12→10)** |
| global-access functions guard-free | 54.6%→61.2% of 1112 | **54.6%→61.2% of 1112** |
| `globalThis.` occurrences | 493→493 | **493→493** |

global-access matches to the digit. expr-rebuild's percentage is 0.4 pt lower and the absolute
baseline drifted (12285→12139) — consistent with the concurrent `call-shape` work changing emitted
output in the shared tree, not a misreport; median is identical and the 12%/12% gate floor holds.
STATUS honestly reports measured numbers short of the spec targets (50%/35%, 100%/95%) with the
reasons, rather than restating the targets. **Honest.**

---

## Device control (D16a) — passes ON

INCONCLUSIVE this run — the device watcher did not return before the review agent stopped (tablet HA2APYTS still attached). Prior pass states passed identically (logcat byte-identical, 0.0000% screenshot); re-run folded into the next pass review.

---

## Verdicts

- **`expr-rebuild` (R1): FIX-THEN-MERGE** — land the H1 loop-invariant guard + its regression test
  before batch 2/3 is considered closed; the commit may stay in history (output is correct on the
  corpus; the gap is latent).
- **`global-access` (R2): MERGE** — the ~61% cap is a correctly-diagnosed emitter limitation, the
  refusal is sound, and the queued `src/emit` widening is the right fix.
