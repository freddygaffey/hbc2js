# 2026-09-04 — the 64 surviving fuzz signatures, grouped into root-cause families

Input: `docs/reports/2026-09-04-finds-retriage-postfix.md` (159 still-failing
finds over 64 distinct signatures, post the P-14 matched-compiler fix).
Method: every signature's example find was re-run through the same ladder the
re-triage used (`matchedCompilerReference: true`, the find's own seed), and the
VM-vs-candidate print dumps were diffed *positionally* — `firstDiff` vs the two
dump lengths — so that a divergence inside the common prefix (a real behaviour
difference) is separated from a divergence that only exists because one side
was cut off (a budget artifact). 36 of the 64 example programs terminate under
Node within 3 s; the other 28 do not, and every one of those 28 diverges only
at its own truncation point.

## Families

| family | signatures | finds | versions | minimal repro | suspected location |
|---|---|---|---|---|---|
| **H1 — non-terminating program, truncation artifact** (not a decompiler bug) | 28 | 110 | 84, 94, 96, 99 | `let c = 1; while (c < 1e21) { print('tick', c); c += 0; }` | `src/harness/ladder.ts` VM cross-check + `src/harness/compare.ts` |
| **F1 — spread-rest deletes a register still read later** | 22 | 35 | 84, 94, 96, 99 | `const a = [0,1,3]; const b = [0, ...a, 1, ...a, 5]; print(b.join(','));` | `src/passes/spread-rest/match.ts` |
| **F3 — missing-global `ReferenceError` message wording** | 9 | 9 | 99 | `try { f2(0, 0); } catch (e) { print(String(e)); }` | `src/emit` global read guard, or harness message masking |
| **F2 — closure / `let` capture value divergence** | 5 | 5 | 96, 99 | not reduced faithfully (see below) | `src/cfg` env graph or `src/emit` closure capture |

Signature-to-family assignment is recorded per example find in
`docs/reports/2026-09-04-finds-retriage-postfix.md`'s order; the counts above
sum to 64 signatures / 159 finds exactly.

## H1 — non-terminating programs (28 signatures, 110 finds): a harness artifact

The mutation-mode fuzzer rewrites a loop bound to `NaN`, `1e21`, `-Infinity` or
`+= 0`, which turns a terminating construct into a non-terminating one. For
such a program the ladder's D14 VM cross-check compares

- `hermesPrint` — the Hermes VM's **raw stdout**, bounded only by the 5 s
  timeout (measured: 3 389 470 lines for `v84-seed778059`), against
- `candidatePrint` — the candidate's trace projection, bounded by
  `maxRecords: 5000` **and** the timeout (measured: 4 999 lines).

The two therefore always differ, at exactly the record where the smaller one
stops. Verified on `v84-seed778059` (`firstDiff = 4999`, `lensA = 3389470`,
`lensB = 4999`, identical up to that point) and `v84-seed781885`
(`firstDiff = 4999`, `lensA = 2314081`). `src/harness/compare.ts` has a
"both traces hit a budget → INCONCLUSIVE" branch, but it is only reachable
when the two record lists have *equal* length (`divergence` is set whenever
`la.length !== lb.length`, before the `truncated` test is consulted), and the
VM cross-check path in `ladder.ts` bypasses `compare.ts`'s record comparison
altogether — it diffs two joined strings.

Consequence: these 110 finds carry **no evidence** about the decompiler, and
the verdict is timing-dependent (re-running `v84-seed783042` gives DIVERGENT
or INCONCLUSIVE depending on machine load). The fix belongs in the harness —
cap both sides identically, or make an unequal-length pair with an identical
prefix INCONCLUSIVE when either side was truncated. This task's brief forbids
harness changes, so it is filed as `PUSHBACK P-16` and a `docs/BUGS.md` row,
not fixed here.

## F1 — `spread-rest` deletes a register that is still read (22 signatures, 35 finds)

Largest genuine decompiler family. Three surface symptoms, one root cause:

```js
const a = [0, 1, 3];
const b = [0, ...a, 1, ...a, 5];   // element after a spread is lost
print(b.join(','));                // VM 0,0,1,3,1,0,1,3,5   candidate 0,0,1,3,,0,1,3,5

const s = 'abc';
print([...s].join('-'));           // first spread fine
print([...s].join('-'));           // second: `[...r8]`, r8 never assigned -> TypeError

const c = [...a]; c.push(0);       // VM copy: 0,1,3,0   candidate copy: 0,1,3,
const o = { ...null, ...undefined, y: 1 };  // VM {"y":1}  candidate {}
```

Root cause, proved by pass bisection on the `[...s]` repro
(`--passes=none` is correct, `--passes=spread-rest` alone reproduces):
`match.ts` folds every "pure setup" statement (`rX = rY` / `rX = <lit>`) of a
matched run into its `Subst` map, and `rewrite.ts` then deletes the whole
`[startIndex, endIndex)` range. Nothing checks that a register written inside
that range is dead afterwards. Hermes stages a spread's source and index
registers once and reuses them for the *next* spread site, so deleting the
first site's staging kills the second site's operands:

```
r3 = new Array(0); r5 = "abc"; r9 = r3; r8 = r5; r7 = 0;
r2 = __hbc_b_arraySpread(r9, r8, r7);      <- site 1: deletes r5/r8/r7
...
r3 = new Array(0); r9 = r3;
r0 = __hbc_b_arraySpread(r9, r8, r7);      <- site 2 still reads r8, r7
```

`check.ts` cannot catch it: it diffs the *effect sequence* of the run, and a
deleted pure register move has no effect in that sequence.

## F3 — missing-global `ReferenceError` wording (9 signatures, 9 finds)

All v99, all the same shape after reduction:

```js
try { const g = f2(0, 0); } catch (e) { print('f2', 'threw', String(e)); }
```

Hermes VM: `ReferenceError: Property 'f2' doesn't exist`. Candidate under
Node: `ReferenceError: f2 is not defined`. Same error *type*, same control
flow, different message text. The decompiler already emits the Hermes wording
for guarded global reads (`if (!("print" in r1)) throw new ReferenceError(
"Property 'print' doesn't exist")`), so this is either an emit gap on the
call-callee path or a gap in the harness's message masking. Needs a decision
before a fix; filed in `docs/BUGS.md`, owner `fix-wave`.

## F2 — closure / `let` capture (5 signatures, 5 finds)

`v96-seed780933`, `v99-seed777358`, `v99-seed777578`, `v99-seed777648`,
`v99-seed777767`. Diverge on *values*, inside the common prefix
(e.g. VM `1 true` vs candidate `f0 NaN`), in fuzz programs built from the
`let outer = 0; …` closure grammar. **Not reduced faithfully**: the reducer
used "still DIVERGENT" as its predicate, and every one of these programs also
contains an F3-shaped missing-global call, so ddmin collapsed them onto the F3
signature instead. Re-reducing needs a signature-preserving predicate.
Filed in `docs/BUGS.md`, owner `fix-wave`.

## Skipped / caveats

- The per-signature minimisation asked for by the brief was done with an
  in-process reducer (one ladder call per candidate, ~0.6 s) rather than
  `tools/fuzz/minimise-live.mjs`: that tool spawns
  `minimise-check-one.mjs` per ddmin candidate *and* hardcodes `seed: 0`
  instead of the find's own seed, which took >5 min per find without
  converging on `v84-seed783042` and reported a different (INCONCLUSIVE)
  target signature than the re-triage did.
- H1's 28 signatures were classified by termination + truncation-point
  measurement rather than by reduction: a non-terminating program has no
  smaller reproducer worth landing until the harness bug is fixed.
