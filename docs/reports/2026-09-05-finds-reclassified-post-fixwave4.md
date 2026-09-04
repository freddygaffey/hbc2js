# 2026-09-05 — fuzz campaign finds reclassified (post fix-wave 4)

Same 201 campaign finds as `2026-09-04-finds-reclassified-post-f2.md`, re-run
after the fix-wave-4 change to `src/harness/ladder.ts`'s Hermes VM cross-check
(commits `50b87c3` + `636b412`). Both runs below are **on the Mac**, single
process, ~25 min each: the finds in question are v94/v96/v99 ones and the Mac
is the only box with a Hermes interpreter for all three (`tools/hermes-vm/v94`,
`tools/hermes-vm/v99`, and `tools/hermesc/v96/hermes`, which is a full
interpreter, not just a compiler — deb has only v94 and v99).

## Verdict table, before and after

| run | PASS | INCONCLUSIVE | DIVERGENT | ERROR |
|---|---|---|---|---|
| post-F2 fix (2026-09-04, Mac) | 99 | 97 | 5 | 0 |
| **before** this fix (2026-09-05, Mac, idle box) | 100 | 98 | 3 | 0 |
| **after** this fix (2026-09-05, Mac, box under gate load) | 91 | 109 | 1 | 0 |

Per version, after:

| version | total | PASS | still DIVERGENT | still ERROR | no local toolchain |
|---|---|---|---|---|---|
| v84 | 50 | 15 | 0 | 0 | 0 |
| v94 | 46 | 9 | 0 | 0 | 0 |
| v96 | 45 | 10 | 0 | 0 | 0 |
| v98 | 1 | 0 | 1 | 0 | 0 |
| v99 | 59 | 57 | 0 | 0 | 0 |
| **total** | **201** | **91** | **1** | **0** | **0** |

**DIVERGENT 5 -> 3 -> 1, and all four fix-wave-4 targets are cleared.** The
single survivor is the already-tracked v98 round-trip row
(`DIVERGENT:roundtrip:roundtrip:function count mismatch: original=# recompiled=#`,
`v98-seed314159`), which is a different bug in a different oracle and has no
Hermes VM to reference at all.

**Read the PASS/INCONCLUSIVE split with care, in both directions.** It moved
100/98 -> 91/109 across these two runs, and *none* of that swing is the fix:
INCONCLUSIVE here is dominated by timeouts, and the "after" run shared the box
with the full gate and two other agents while the "before" run had it to
itself. That is the same caveat the post-F2 report carries. The 5 -> 3 drop
between 2026-09-04 and the "before" run of 2026-09-05 is the same effect: two
of the three shared-`let` finds happened to fall on the INCONCLUSIVE side of
the timing race that this fix removes.

## What the four finds actually were: the harness, not the decompiler

The BUGS row that carried them (and the post-F2 report) read the trace diff
backwards. In `ladder.ts`'s trace comparison, `a` is the **candidate** and `b`
is **source.js under Node** — so

```
0 - out print "let closures each see own i: 16,16,…"     <- candidate
0 + out print "let closures each see own i: 0,1,2,…"     <- source.js under Node
```

says the *candidate* printed `16,16,…`. The decompiler was right all along, and
the emitted code was never a per-iteration binding: `--passes=none` and the
default pipeline both emit one shared environment slot (`_e0_0`) that every
closure created in the loop reads, which is exactly what the bytecode has.

Verified directly with the real interpreters on the Mac, on a three-iteration
reduction of the family (`for (let i = 0; i < 3; i++) closures.push(() => i)`):

| engine | output |
|---|---|
| `tools/hermesc/v96/hermes` | `let closures each see own i: 3,3,3` |
| `tools/hermes-vm/v94/bin/hermes` | `let closures each see own i: 3,3,3` |
| `tools/hermes-vm/v99/bin/hermes` | `let closures each see own i: 3,3,3` |
| `node` | `let closures each see own i: 0,1,2` |

Every Hermes shares one `let` binding across the loop's iterations (D14); Node
gives each iteration its own. The candidate agrees with Hermes at all three
versions. This also settles the v96 question raised mid-task (deb ran v96
against Node because deb has no v96 interpreter): the Mac's `tools/hermesc/v96/hermes`
is a real interpreter, it was the reference for every v96 run in both runs
above, and it prints `3,3,3`.

So the finds were three harness bugs, all in the Hermes VM cross-check.

**(1) The P-16 budget rule threw away the VM's only line.** All three
shared-`let` finds print exactly one line and then loop forever (a
`-Infinity` counter that `++` never advances). Both sides are therefore
budget-limited, and the old rule capped the compared prefix at
`min(candidateLines, vmLines) - 1` — dropping one line off the *shared* cap to
guard against a VM killed mid-line. With one line each that is `cap === 0`:
nothing verified, no `vmAgreesEvidence`, and the Node-vs-candidate difference
stood as DIVERGENT even though the VM had printed the candidate's line
verbatim. The trailing line is now dropped only where a mid-line cut is
actually possible — the VM's stdout when it does not end in a newline — and
never on the candidate's side, whose lines come from whole trace records that a
record cap or a timeout can only cut *between*, never inside. (The candidate's
one genuinely suspect trailing line, the engine-resource `uncaught …` marker,
was already sliced off separately.)

**(2) A refuted divergence still counted as evidence against the candidate.**
`cmp` compares the candidate against *source.js under Node*. Even with `cap`
fixed, the old code refused to weaken a DIVERGENT `cmp` in the budget branch on
the stated grounds that "a candidate-vs-Node divergence found inside the prefix
is real evidence". It is the opposite: if the record the two disagree on
printed inside the lines the VM has just reproduced byte-for-byte, the D14
ground truth sided with the candidate at exactly that point. New helper
`vmRefutedDivergence` says so — the divergence must be an *output* record whose
text lies wholly inside the verified prefix, so a divergence the VM never
observed (past `cap`, or on a non-output record) still stands as DIVERGENT.
The weakened verdict is INCONCLUSIVE, never PASS: neither side ran to
completion, so nothing past the cut-off is evidence either way (HA-01).

**(3) Only the candidate's engine-resource ceiling was recognised.** Find
`v99-seed777142` prints three lines and then grows an array in a loop whose
counter never advances. Node dies with `RangeError: Invalid array length`,
which `isResourceCeilingRecord` knows, so the candidate's `uncaught RangeError`
marker line came off. Hermes dies of the identical wall but words it
`Requested an array size that fails to allocate` (and reports heap exhaustion
as an `LLVM ERROR: OOM` abort with no `Uncaught` line at all), which nothing
recognised — so the VM's marker line stayed on, the two projections differed by
exactly that line, and the ladder reported "candidate diverges from Hermes VM
v99's own execution of the original bytecode". Measured, with identical
stdout on both sides:

```
candidate: ["…final n=-20", "body runs…x=999", "body runs…x=999"]           (ceiling marker stripped)
VM:        ["…final n=-20", "body runs…x=999", "body runs…x=999", "uncaught RangeError"]
```

`VM_RESOURCE_CEILING` now recognises both shapes; the marker comes off both
sides together and the VM counts as budget-limited. That also removes a
run-to-run flip this find had: whether the abort beat the 5 s `timeoutMs`
decided between DIVERGENT (`vmBudgetHit` false, full-length compare) and
INCONCLUSIVE (`vmBudgetHit` true), which is why `minimise-live.mjs` reduced it
to an INCONCLUSIVE signature on one run and the campaign recorded DIVERGENT on
another. All four finds are now stable across repeated single runs.

## Minimisation

All four reduced with `tools/fuzz/minimise-live.mjs` (signature-preserving
predicate, seeded from the filename, in process):

| find | lines | reduced to | signature preserved |
|---|---|---|---|
| `v94-seed780867` | 16 | 9 | yes |
| `v96-seed781844` | 15 | 15 (ddmin found no smaller signature-preserving program) | yes |
| `v96-seed782973` | 15 | 15 | the final re-check came back PASS, i.e. the *signature itself* was timing-dependent — the direct evidence for cause (1)/(3) |
| `v99-seed777142` | 21 | 7 | yes |

## Tests

`tests/gate/harness/ladder-budget-prefix.test.ts`, three cases, all red before
`50b87c3` and green after:

1. the reduced `v94-seed780867` program end to end (real hermesc, real
   decompiler, real v94 VM): verdict must be INCONCLUSIVE, the caveats must say
   the divergence was *refuted*, and the verified prefix must be non-empty
   (`cap === 0` is the bug);
2. the reduced `v99-seed777142` shape: the VM's own ceiling must be reported as
   a ceiling, not as a divergence;
3. soundness — a candidate that really disagrees with the VM inside the
   observed prefix stays DIVERGENT *and* is reported against the VM, which
   before the fix it was not (it was reported against source.js).

Case 2 was first written with the find's literal array-growth ceiling, which
takes the VM seconds and raced the ladder's 5 s timeout under full-gate load
(two gate failures, `50b87c3` and `8c0507c`). It now uses unbounded recursion
instead: the same ceiling class (`RangeError: Maximum call stack size
exceeded`, in both `trace.ts`'s `RESOURCE_CEILING_MESSAGES` and `ladder.ts`'s
`VM_RESOURCE_CEILING`), reached in ~16 ms by `tools/hermes-vm/v99/bin/hermes`,
measured. The test runs in ~0.6 s (`636b412`).

Existing `tests/gate/harness/{ladder-budget-truncation,compare,ladder-d14-override,ladder-uncaught}.test.ts`
are unchanged and green (25 cases).

## No fixtures, and why

The brief asked for the reductions to land as construct fixtures
(`61-…`/`62-…`) or an adversarial fixture (`47-…`). They deliberately did not:

- every one of these programs is **non-terminating by construction** — the
  budget cut-off is the bug, so a fixture that reproduces it must run until a
  timeout or an engine ceiling. `tests/fixtures/constructs/**` is compiled for
  every version by `build.sh` and traced by the gate at each of them; an
  adversarial fixture is swept by `tests/sweep/adversarial/report.test.ts`.
  Either would add tens of seconds of pure timeout to a tier, at every version,
  forever, and would sit at INCONCLUSIVE rather than PASS — the adversarial
  corpus's README contract is "deterministic, output only via `print(…)`,
  PASS at every compiled version";
- the *semantics* half needs no new fixture: shared-`let` capture is already
  `tests/fixtures/adversarial/06-closure-loop-var-vs-let`, and it passes;
- the bug is in the oracle, not in emitted code, so the regression test that
  can actually go red is a ladder test, which is what shipped. All three cases
  drive the real hermesc, the real decompiler and the real VM — they are
  end-to-end in everything but the fixture directory.

No existing golden under `tests/golden/` is affected: this change touches only
`src/harness/ladder.ts`'s verdict logic, and no decompiled byte moves.

## Left open

- `v98-seed314159` — the round-trip function-count mismatch, unrelated, its own
  BUGS row, and unreachable by a VM cross-check (no v98 VM exists).
- The `PASS`/`INCONCLUSIVE` split is still load-dependent across whole runs.
  Individual finds are now stable; the aggregate is not, because the 5 s
  `timeoutMs` is wall-clock. Making the campaign's totals reproducible would
  need a work-budget that is not wall-clock (instruction count or record count
  on both sides), which is a harness design change, not a fix.
