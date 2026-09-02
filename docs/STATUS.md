# Project status

Full history: `docs/STATUS-ARCHIVE.md`. Last rewritten: 2026-09-01.

Goal: decompile React Native Hermes bytecode into a readable, segregated
`src/` tree — library code stripped out, app code (views, pages, navigators,
stores) split into real files. (docs/LANES.md)

## Scoreboard

| stage | metric | rn-template | react-navigation | Service NSW | source |
|---|---|---|---|---|---|
| 1 valid JS | % `node --check` clean / stubbed | 100% (436/436), 0 stubs | 100%, 0 stubs | 100% (4510/4510), 0 stubs | docs/e2e/RESULTS.md 2026-09-01 table; STATUS-ARCHIVE.md D17i stage 1 |
| 2 equivalent | % functions IDENTICAL round-trip, passes-on (strong normalisation) | 37.5% | 32.9% | 29.1% (legacy, not remeasured) | docs/e2e/RESULTS.md 2026-09-01 "strong normalisation" table |
| 3 boots | RN-web / device boot | no (bare-Node harness: 87/435 modules, `registerComponent` yes, no rnweb/jsdom yet) | no — not attempted | no — not attempted | tools/e2e/boot-split.mjs + tools/e2e/boot-expected/rn-template-0.72.json 2026-09-01; docs/e2e/STAGE3-FEASIBILITY.md; docs/CONSOLIDATION.md item 31 |
| 4 segregated | % instructions classified LIBRARY vs CUSTOM | 41.1% library | 26.5% library | not measured (`deps` >10 min, item 30) | STATUS-ARCHIVE.md "Classification: library vs custom" 2026-08-31; footnote local-corpus MetaMask 39.5%, Brex 25.1%, Discord 13.6% (same section) |
| 4 segregated | `hbc2js segregate` (milestone 1, by module count) | 308/435 (70.8%) → `node_modules/` (303 named `react-native`, 5 `_vendor/`), 72/435 (16.6%) → `src/`, 55/435 (12.6%) → `_unclassified/` | 1257/1782 (70.5%) → `node_modules/`, 345/1782 (19.4%) → `src/`, 180/1782 (10.1%) → `_unclassified/` (P-10 fix, 2026-09-02: was 829/726/227 — confirmed per-module `moduleOwnership` now overrides classify.ts's heuristic when they disagree, moving 428 modules `src`/unclassified→`node_modules`) | not measured (`deps` >10 min, item 30) | docs/specs/08-segregation.md §5 2026-09-02, P-10 fix same day; `hbc2js segregate` on rn-template-0.72's `--split` tree + its own `deps --offline` report; react-navigation column: `tools/e2e/oss-benchmark.mjs` 2026-09-02 |
| 4 segregated | OSS ground-truth benchmark: library classification vs `.map` (package-level, see caveat) | not scored (no `.map`) | precision 41.2% (n=1033 modules w/ guessed pkg), recall 9.1% (6/66 real deps, 8 packages detected) — P-10 fix, 2026-09-02: was 52.2%/605, 6.1%/6; recall genuinely improved (more real deps get ≥1 correctly-bucketed module: react-native/-screens/-reanimated, react, async-storage, gesture-handler now all detected), precision's DROP is a benchmark ground-truth artifact specific to this monorepo fixture (`@react-navigation/*` is built from workspace source here, never a literal `node_modules/@react-navigation/...` path, so `loadTruth` can never credit it — 607 of the 1033 guessed-pkg modules are exactly those two packages, correct by hash-match but uncreditable by this benchmark; see `docs/BUGS.md` 2026-09-02 P-10 row) | not measured | docs/e2e/OSS-BENCHMARK.md; `tools/e2e/oss-benchmark.mjs` 2026-09-02, baseline `docs/e2e/oss-benchmark-baseline.json` |
| 5 readable | `hbc2js segregate` (milestone 2, naming): % `src/` modules named (not `module_N.js`) | 1.4% (1/72, entry module → `src/App.js` via app-registration signal) | 8.0% (58/726) — see milestone 3 row | not measured | docs/specs/08-segregation.md §6 milestone 2 result, 2026-09-02; expected near-floor per spec §5 — rn-template ships no screens/store to exercise steps 3-5 |
| 5 readable | `hbc2js segregate` (milestone 3, screens/navigators): detected / named / fuzzy-match vs `.map` | n/a (no navigation) | 50 screens, 3 navigators (P-10 fix, 2026-09-02: was 54/4 — module 1122, a `@react-navigation/native` barrel confirmed by `moduleOwnership`, now correctly buckets to `node_modules/` instead of miscounting as a 4th `src/` navigator); 53/345 `src/` named (15.4%); mean fuzzy similarity 0.687, 9.4% ≥0.8 (best-match vs `.map`, id↔source correspondence not recoverable — see caveat in `tools/e2e/name-accuracy.mjs`) | not measured | docs/specs/08-segregation.md §6 milestone 3 result + "Seventh revisit", 2026-09-02; `tools/e2e/name-accuracy.mjs` |
| 5 readable | OSS ground-truth benchmark: naming closeness vs `.map` (monorepo-scoped truth, see caveat) | not scored (no `.map`) | mean fuzzy similarity 0.66, 8.6% ≥0.8 (199 real `/example/` basenames only — excludes react-navigation's own `/packages/*` source, corrected from the milestone-3 row's 340-basename truth set) | not measured | docs/e2e/OSS-BENCHMARK.md; `tools/e2e/oss-benchmark.mjs` 2026-09-02 |
| 4 segregated | `hbc2js segregate` (milestone 1, by module count) | 308/435 (70.8%) → `node_modules/` (303 named `react-native`, 5 `_vendor/`), 72/435 (16.6%) → `src/`, 55/435 (12.6%) → `_unclassified/` | not measured (needs `deps` run, item 30's fetch) | not measured (`deps` >10 min, item 30) | docs/specs/08-segregation.md §5 2026-09-02; `hbc2js segregate` on rn-template-0.72's `--split` tree + its own `deps --offline` report |
| 5 readable | `hbc2js segregate` (milestone 2, naming): % `src/` modules named (not `module_N.js`) | 1.4% (1/72, entry module → `src/App.js` via app-registration signal) | not measured (needs `deps` run, item 30's fetch) | not measured | docs/specs/08-segregation.md §6 milestone 2 result, 2026-09-02; expected near-floor per spec §5 — rn-template ships no screens/store to exercise steps 3-5 |
| 5 readable | `hbc2js segregate` (milestone 3, screens/navigators): detected / named / fuzzy-match vs `.map` | n/a (no navigation) | WITH deps: 54 screens, 4 navigators, mean fuzzy 0.686 (unchanged). NO deps (2026-09-02, deps-optional detection): 58 screens, 6 navigators, mean fuzzy 0.654. Navigators now named from their own route set's common prefix when resolvable (`LicenceNavigator.js`), a dominant-domain/role name when the set has no shared prefix (`LicenceNavigator` off a plurality domain, else `RootNavigator`/`MainTabNavigator`, 2026-09-02 4th revisit), else `<Type>Navigator` | NO deps only (`deps` >10 min, never run): 176 screens, 17 navigators (was 18, 2026-09-02 6th revisit: `detectNavigator` now refuses a flat require+call+export module with no owned/consumed route config — see docs/BUGS.md, docs/PUSHBACK.md P-10 for the broader gate blocked by react-navigation-example's pinned hard bar). 1 of the 17 route/role-named (`RootNavigator`). react-navigation-example numbers (this column, left) unchanged | docs/specs/08-segregation.md §3/§6 milestone 3 result, 2026-09-02; `tools/e2e/name-accuracy.mjs [--no-deps]` |
| 5 readable | var-naming: registers named | 4.1% (bundle) / 3.1% (57-fixture matrix) | – | – | STATUS-ARCHIVE.md `var-naming` R5, 2026-08-31 |
| 5 readable | jsx-recover: element sites recovered | 9.7% (15/154) | – | – | STATUS-ARCHIVE.md `jsx-recover`, 2026-09-01 |
| 5 readable | template-literal: sites converted | 99.45% | – | – | STATUS-ARCHIVE.md `template-literal`, 2026-09-01 |
| 5 readable | surviving `rN` per 1k lines | – | – | – | not yet tracked (no docs/reports entry) |

## Milestones

- M0 Research (toolchain, prior art, corpus candidates) — done
- M1 Parser (all 5 layout classes, v84/94/96/98/99) — done
- M2 Disassembler (100% match vs `hermesc -dump-bytecode`) — done
- M3 Test harness (trace runner + recompile round-trip) — done
- M4 Baseline (CFG + structurer + emitter) — done, 501/501 gate, 0 DIVERGENT
- M5 Pass ladder (readability) — in progress, 15/30 rungs merged
- M6 CLI + Tier 2 sweep (real bundles survive, clean round-trip) — not started

## Ladder — 15/30 rungs live

`loop-cond`, `for-header`, `switch-raise` (S1), `if-chain`, `label-clean`,
`expr-rebuild`, `global-access`, `call-shape`, `default-params`,
`destructure`, `spread-rest`, `template-literal`, `fn-naming`, `var-naming`,
`jsx-recover` (opt-in `--jsx`). Next (batch 3): TBD.
Source: docs/specs/passes/00-LADDER.md; STATUS-ARCHIVE.md M5 section.

## Gate

`npm test` (this run, 2026-09-02): 1668 tests, 1664 pass, 0 fail, 4 skipped,
~111 s. CI: red-CI root cause (typecheck not run locally) fixed 2026-08-31 —
`npm test` now runs typecheck first; source: docs/CONSOLIDATION.md item 29.

## Open bugs — 24 open / 23 resolved, docs/BUGS.md (triaged 2026-09-01, QUEUE 4; +2 rows 2026-09-02 destructure landing; +1 row 2026-09-02 spread-rest landing)

By cluster (open only): emit-shape 7, metrics 3, passes 4, real-app 2,
harness 2, deps 1, toolchain 2. Every open row has a status, cluster and
verdict; resolved rows (fixed/wontfix/d14-legit/duplicate) moved to
`## Resolved`. Gate: `tests/gate/docs/bugs-ledger.test.ts`.

## Blocked / needs Fred

- reg-split rung (real variable names) — **specced 2026-09-02**
  (`docs/specs/passes/19-reg-split.md`; P-6 resolved); awaiting
  implementation (docs/QUEUE.md item 1).
- Device round-trip on a real app — needs a tablet attached.

## Queue — top 5 (docs/QUEUE.md)

1. STATUS.md → one screen (this task).
2. Sweep-on-every-merge + workflow rules into `docs/AGENT-WORKFLOW.md`.
3. BUGS.md triage: verdict + status per open row, cluster.
4. `deb` job server (Fred-requested small Node HTTP job runner).
5. Bulk signature DB round 2 on `deb` (100% module attribution goal).

Numbers are measured, not hoped — every cell cites its source file.
