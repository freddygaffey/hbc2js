# 2026-09-05 -- Service NSW whole-file re-timing after perf parts 2-4

Ledger row: `docs/BUGS.md` 2026-09-01 "passes-superlinear-term-2" (the "452 s /
946 s" row). Re-timed on deb (`~/hbc2js-perf`, checkout `9df2ba7` off
`origin/wip/pending-goldens`, real `~/hbc2js-corpus/nsw.hbc`, 12.7 MB, never
committed -- this report carries aggregate numbers only). Box was shared with
a live fuzz campaign (`campaign3-v84-4000000`) plus desktop apps: ~18-19 GB of
31 GB RAM in use, 6+ GB swapped, load average 2-3 throughout -- noisier than
the earlier 946 s/563 s sessions' box.

## Timings (each run once)

| case | flags | wall | max RSS |
|---|---|---|---|
| whole-file, passes-on | `--lenient-env` | **981 s** (was 563 s) | 4.28 GB |
| whole-file, passes-off | `--passes=none --lenient-env` | **29.5 s** (was 19 s) | 3.50 GB |
| `--split`, passes-on | `--split <dir> --lenient-env --overwrite` | **39.3 s** (was 512 s) | 3.60 GB |

`--split` produced all 4,510/4,510 modules, 43,384 functions. Neither
whole-file run's exit status nor output size was re-verified beyond the
`--info`/log tail (byte-for-byte content not compared; out of scope for a
timing-only session).

## `--split`'s 13x drop is real, not noise

If the box's memory pressure were the dominant factor, every run would be
slower, not one 13x faster. `--split` never builds the one `fn#0` module-root
list with 4,510 factory-call statements that whole-file must; parts 1-4's
bounded-region fixes (`nextRelevant`, `expressionOnlyCheck` prefix/suffix
stripping, `registerUseDelta`, `withoutAt`) make each module's own (short)
fold-site list cheap, so per-module cost collapsed close to the passes-off
floor.

## Whole-file: the materialisation floor, relocated

A `--cpu-prof` of the whole-file passes-on run (1045 s sampled) shows GC at
250 s self time (24%), then, all in `src/passes/expr-rebuild/match.ts`:
`classifySite` (51.7 s), `nextRelevant` (40.6 s + 29.6 s, two call sites),
`scanFrom` (23.8 s), `stmtInterest` (20.7 s + 19.6 s, two call sites), then
`ast.ts`'s `visitExpr` (18.9 s). Each of these is individually bounded
(O(window) per part 1's fix), but `fn#0`'s ~4,510 fold sites each re-run the
scan over a list thousands of statements long, so the aggregate is still the
Theta(sites x list.length) floor PUSHBACK P-33/P-34 named -- parts 3-4 moved
the floor off `defUse`/`rewrite` (now cheap) onto this classify/scan layer,
for this one function shape.

## Row disposition

Left `open`: whole-file (981 s) is further from the 60-120 s bar than the
prior 563 s measurement (box noise plausible, not proven the whole story);
`--split` (39.3 s) is now well inside any reasonable bar. `docs/BUGS.md`'s
row updated in place with these numbers; scope narrows to whole-file's
`fn#0`-shaped case specifically -- perf part 5 (persistent list / patch
driver) remains the only known fix for that shape.
