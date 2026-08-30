# M5 pass 5 review — `fn-naming` (row R4, commit `5744c3b`)

Reviewer: Claude Opus 4.8 (2026-08-30). Review-only on `src` (read, never edited).

## Verdict: **MERGE**

Pure alpha-renaming of `_fnN` from bytecode evidence. I could not construct a
case where a rename passes `check` but changes behaviour. Metric honest; device
INCONCLUSIVE (tablet busy with another roundtrip). One informational note (F1),
no code change required to merge.

---

## 1. Names recovered, applied consistently (spec targets + bundle)

Emitted JS ON vs `--passes=none`, v94, all four target fixtures:

- **19-var-hoisting** — `_fn1→demo`, `_fn2→hoistedFn`; `_fn0` correctly left
  (global). `globalThis.demo = demo` reference folded and renamed.
- **21-iife-closures** — `_fn2..5→increment/decrement/reset/value`,
  `_fn6→selfRef`; the outer anonymous IIFE correctly left `_fn1`. (Its
  recursion runs through the env slot `_e0_0`, not an `_fnN` ident, so the
  self-ref-ident path is exercised by the unit tests, not this fixture.)
- **22-nested-closures-counters** — `makeCounter/step/makeAccumulatorFactory/
  makeAccumulator/accumulate`; the anonymous `.reduce` callback correctly left
  `_fn6`.
- **17-closure-loop-var** — every closure is genuinely anonymous (callbacks to
  `.push`/`.map`, a `CallDirect`), all correctly left `_fnN`; output
  byte-identical ON vs OFF.

Every reference is renamed at every site. Traced by hand in 17-closure-loop-var
that the **`CallDirect` reference `_fn3(r6)` (line 75) and its declaration
`function _fn3` (line 16) sit in the same function body (`_fn0`)** — the
rewrite's whole-tree `renameIdent` covers it. Recursive/nested references are
covered because `_fnN` is a **non-register** name, so the scope-aware
`identUses` (371c678) does **not** skip nested `func` bodies for it (it skips
nested only for `rN` queries); the checker's item-4 zero-survivor assertion
counts `nested` too, so a missed nested self-reference is a hard refusal.

No collisions/shadowing observed. `23-generator-basic` demonstrates the
conservative anti-collision: after `_fn3→sequence`, the sibling `_fn1`
(same bytecode name) is refused `already-declared` because `declaredNames`
walks the now-renamed nested body — two functions never share a name across an
enclosing/nested boundary.

## 2. Adversarial soundness probe — no gap found

The rename is sound because of two load-bearing invariants I verified in the
emitter (read-only):

1. **The only `_fnN` reference outside a function body is the global's.**
   `src/emit/index.ts:262` emits `_fn{globalIndex}.call(globalThis)` at module
   level — and condition 1 (`isGlobalFunction`) refuses exactly that index.
   Every other `_fnN` ident is produced by a `CreateClosure`/`CreateGenerator`/
   `CreateBaseClass`/`CreateDerivedClass`/`CallDirect` lowering
   (`src/emit/lower.ts:597,604,607,612,620,652`), i.e. inside the declaring
   parent's own instruction stream — the same `ctx.fnBody` tree the rewrite
   rebuilds. So renaming within one `fnBody` reaches **every** reference to a
   non-global `_fnN`. There is no cross-body reference to miss.

2. **The rename fires only when `to` occurs nowhere in the whole `fnBody`
   tree.** Condition 4 (`freeNames`) rejects `to` if it appears as a free use;
   condition 5 (`declaredNames`) rejects it if bound anywhere — both recurse
   into nested `func` bodies. Their union is "every name that appears as a use
   or a binding", so a firing rename's `to` is provably fresh in the entire
   subtree. That closes each attack vector in the brief:
   - **collide with a later binding** — `var-naming`/`class-recover` run *after*
     `fn-naming` (and are not yet registered); they see the recovered name as a
     declared `func` and must avoid it. Not this rung's concern, and not
     reachable today.
   - **shadow a global the body uses** — refused by condition 4 (e.g. a body
     using free `print` cannot be renamed to `print`); the self-capture case
     (`_fnN` body calling free `bar`, rename→`bar`) is the same refusal.
   - **two functions get the same name** — same list: `duplicate-name`
     (condition 6, cross-candidate). Enclosing/nested: `already-declared` via
     whole-tree `declaredNames` (the `23-generator-basic` case). Disjoint
     sibling scopes: valid JS, no shadowing, sound.
   - **nested closure reusing a register isn't/​is wrongly renamed** — the
     register-scoping subtlety of 371c678 does not touch `fn-naming`: its
     target is `_fnN` (non-register, globally unique per function-table entry),
     so nested references are unambiguously the same entry and are renamed;
     no register-frame aliasing exists for `_fnN`.

`check` re-derives `(from,to)` by structural diff and **re-runs conditions 2–5
on `before`** rather than trusting the match, then verifies the free-name
delta, the reference-count identity, the `nested`-inclusive zero-survivor of
`from`, and the print-and-undo byte-identity. Its soundness does not depend on
`to` being the "right" readable name — any fresh safe name is a valid
alpha-rename — so a wrong evidence pick would be a readability miss, never a
correctness bug. `findRename` scans only top-level statements, which is correct:
`classifyAll` only ever sites a top-level `func` statement, and `_fnN` is
unique, so exactly one top-level name differs.

**No HIGH/MEDIUM findings. No regression test requested.**

## 3. The 9 refusals + R4b `already-declared` (F1)

All nine (`global-function`, `anonymous`, `unsafe-identifier`, `reserved-word`,
`emitter-name-class`, `captures-free-name`, `already-declared`,
`duplicate-name`, `ambiguous-name`) are each justified and independently
reachable (unit-tested, 83 cases green).

**F1 (informational, not a blocker).** R4b's `{k:"init", name:key, value:
ident(_fnN)}` evidence form is **dead**: the `init` statement that supplies the
name `key` also *declares* `key`, so condition 5 (`declaredNames`) always
refuses it `already-declared`. This is **sound and desirable** — renaming would
emit `function key(){} … let key = key;`, a redeclaration / TDZ self-reference —
and it is explicitly documented and unit-tested
(`fn-naming.test.ts`, "R4b's `init`-form evidence is recognised, but re-running
condition 5 always refuses it"). It does **not** silently kill valid renames:
the member-write form (`X.key = _fnN`, a property key, never a binding) is the
half the corpus actually exercises, and it fires. R4b as a whole is **not**
dead — only its `init` sub-branch (`match.ts` `assignmentKey`'s first `if`) is
unreachable-to-success. Optional cleanup for a future edit: drop that branch or
annotate it as evidence-only; harmless as-is. No action required for merge.

## 4. Device (D16a) — INCONCLUSIVE

`adb devices` showed tablet `HA2APYTS` in `device` state, but a
`tools/device-roundtrip.sh --variant js` run was already in flight (live
`node src/cli.ts` decompile + gradle daemon; PIDs 42562/43775/43776). Per the
brief, did **not** launch a second roundtrip against the one tablet — it would
collide on install/launch/`uiautomator dump`. Recorded INCONCLUSIVE. No
device-specific risk suspected (this rung is a stage-B alpha-rename behind the
same `parses` guard as batches 1–4, which passed on-device at 0.0000%). Re-run
when the tablet is free and record both RMSE numbers here.

## 5. Metric honesty

STATUS reports **61.3%** named (98/160 non-global functions,
`tests/fixtures/constructs/**` v94). `measureFnNaming()` computes **61.25%**
(98/160) — 61.3% is that value to the reported precision, honest. Baseline 0%.
Short of the spec's 80% target, and STATUS says so; the residual is genuinely
anonymous source-level closures (bare `.push`/`.then`/`.map` callbacks, async/
generator continuation machinery), not a rung defect. The 58% floor guard in
`fn-naming-metrics.test.ts` is green.

## Gate

`npm test`: fn-naming unit+metrics (83) green; framework + imports gate green.
Full-suite tail matches STATUS's recorded 1281/1281-minus-known-fuzz-flake and
`{"pass":511,"divergent":0}` real-decompiler tier.
</content>
</invoke>
