# 2026-09-05 -- perf part 5: measuring the classify/scan layer's exponent

Ledger row: `docs/BUGS.md` 2026-09-01 "passes-superlinear-term-2" (the
"452 s / 946 s" row). Evidence this session starts from:
`docs/reports/2026-09-05-nsw-retime.md` (whole-file NSW 981 s vs `--split`
39 s; top frames after GC all in `src/passes/expr-rebuild/match.ts`).

All numbers below are CPU ms on the Mac (`process.cpuUsage`), one process
per shape, measured **before** any change in this session. The generator is
the one `tests/gate/passes/expr-rebuild-perf.test.ts` already uses
(`applyAstPasses` driving `exprRebuild` over a synthetic module-root list).

## The shape matters more than the size

| shape | statement list | 2k sites | 4k sites | 8k sites |
|---|---|---|---|---|
| A | `rN = source(n); use(rN)`, register alphabet of 8 (reused) | 118 ms | 274 ms | 833 ms |
| B | shape A with one site in four refused (`two-reads`) | 131 ms | 338 ms | 1097 ms |
| D | `rN = source(n); use(rN)` with a **unique** register per site | 940 ms | 4458 ms | 25526 ms |

Shape D is the module-root (`fn#0`) shape the NSW profile points at: each
site's register is stored once, read once, and then never mentioned again in
the rest of the list. Its exponent is **~2.3** (2x N costs 4.7x then 5.7x),
against ~1.6 for shapes A and B. At 8k sites shape D costs **30x** shape A.

Existing coverage measures shape A only, which is why the gate never saw
this: with a register alphabet of 8, the next mention of any register is a
dozen statements away, so every scan in `match.ts` terminates almost
immediately.

## Cost per site is linear in list length

Shape C isolates it: a fixed 500 fold sites at the head of the list, then a
growing tail of inert statements that mention no register and contain no
jump.

| inert tail | 0 | 2,000 | 8,000 | 32,000 |
|---|---|---|---|---|
| CPU | 8 ms | 15 ms | 50 ms | 180 ms |

500 sites, identical work per site, cost proportional to the length of a
tail none of them needs to look at: `Theta(sites x list.length)`, exactly
what PUSHBACK P-33/P-34 named.

## Where it goes (`--cpu-prof`, shape D, 1k+2k+4k sites in one process)

| self time | frame |
|---|---|
| ~4.9 s | `ast.ts` `countUses` internals (`bump`, `visitExpr`, `visitStmts`, `isRegisterName` and its regex) |
| 2.6 s | `match.ts` `nextRelevant` (two call sites) |
| 1.6 s | `match.ts` `stmtInterest` |
| 1.6 s | `ast.ts` `incrementalReadBeforeDef` |
| 0.6 s | GC |

Two `Theta(sites x list.length)` terms, both reached from
`match.ts`'s `isDeadAfter`:

1. **The scan.** `isDeadAfter` tries `tryDA` first, which is
   `scanFrom(list, reg, j + 1, ...)`. For a register never mentioned again,
   `nextRelevant` walks every remaining statement to `list.length` before
   the scan can conclude anything - one full tail walk per site. That is the
   `nextRelevant` + `stmtInterest` 4.2 s.
2. **The counts.** Only when the scan fails does `isDeadAfter` consult D-b's
   whole-function counts, `registerUses(ctx.fnBody)`. That map is memoised
   on the list's identity, and every applied site gives the edited list a
   fresh identity, so it is a cold whole-list `countUses` walk once per
   site. That is the 4.9 s.

Both are avoidable without changing a single verdict, because `isDeadAfter`
is an `||` of two pure predicates:

- the counts are the *cheap* one, if the map is already paid for - so
  consult it first whenever it is already memoised, and only then scan;
- the map can be *carried across a splice* instead of rebuilt, on exactly
  the concatenativity argument `expr-rebuild/check.ts`'s `registerUseDelta`
  already uses, since `check` has by then proven position by position that
  `after` is `before` with one bounded window replaced.

Neither changes which sites match: same predicates, same values, evaluated
in a cheaper order over a map derived rather than recomputed. Results after
the fix are in the same row of `docs/BUGS.md`.

## After the fix (same machine, same generator, same session)

Two changes, both verdict-preserving:

1. `expr-rebuild/match.ts`'s `isDeadAfter` asks D-b's whole-function counts
   first whenever that map is already memoised (`registerUsesIfMemoised`),
   and only then runs D-a's scan; when the map was cold it still scans
   first, exactly as before. Two pure predicates joined by `||`, so the
   order is free.
2. `expr-rebuild/check.ts` derives the accepted list's register-use map from
   the one it just proved (`noteRegisterUsesSplice` in `ast.ts`) instead of
   leaving the next iteration to rebuild it, so the map is warm for every
   site after the first.

| shape | 2k sites | 4k sites | 8k sites |
|---|---|---|---|
| D, before | 940 ms | 4458 ms | 25526 ms |
| D, after | 398 ms | 1487 ms | 7105 ms |
| A, before / after | 119 / 116 ms | 280 / 273 ms | 858 / 824 ms |

Shape A (the shape the gate already covered) is unchanged, within noise.
Shape D is **3.6x** faster at 8k sites.

The layer this session was pointed at is gone from the profile. A
`--cpu-prof` of shape D after the fix has no `classifySite`, `nextRelevant`,
`scanFrom` or `stmtInterest` frame in the top ten at all (they were 4.2 s of
14.9 s before), and no `countUses` frame either (4.9 s before). The direct
proof is `tests/gate/passes/expr-rebuild-perf.test.ts`'s new ratio: 500
classify calls with a 20,000-statement inert tail behind them against the
same 500 with none. Pre-fix that ratio measures **37.9x**; post-fix it is
~1x, budget 4x.

## What is still superlinear, and why

Shape D's exponent is still ~2.2 (398 -> 1487 -> 7105). The top frames are
now `noteRegisterUsesSplice` itself (its one `new Map(base)` copy per site,
`O(distinct register names)`), `incrementalReadBeforeDef`, `withoutAt`'s
single array build and `verifyExpectedShape`'s pointer sweep - i.e. the
`readonly Stmt[]` materialisation floor PUSHBACK P-33/P-34 named, plus one
new `O(distinct register names)` term this change adds in its place. Note
shape D is deliberately adversarial for that term: it gives every one of its
thousands of sites its own register name, so `distinct register names` grows
with the list. A real function's register frame does not grow that way, and
the trade is strictly favourable either way - a map copy per site replaces a
whole-list `countUses` walk per site.

Removing the rest needs a persistent list representation or a
patch-returning driver contract (perf part 6), not more work in this layer.

The wall-clock verdict this row is judged on is a Service NSW whole-file
re-timing, which needs the bundle and therefore deb: the orchestrator
re-times there. Nothing in this session touched
`tests/gate/passes/pipeline-speed.test.ts` or its rn-template output hash,
which the gate re-checks unchanged.
