# Project status

Full history: `docs/STATUS-ARCHIVE.md`. Last rewritten: 2026-09-01.

Goal: decompile React Native Hermes bytecode into a readable, segregated
`src/` tree — library code stripped out, app code (views, pages, navigators,
stores) split into real files. (docs/LANES.md)

## Scoreboard

| stage | metric | rn-template | react-navigation | Service NSW | source |
|---|---|---|---|---|---|
| 1 valid JS | % `node --check` clean / stubbed | 100% (436/436), 0 stubs | 100%, 0 stubs | 100% (4510/4510), 0 stubs | docs/e2e/RESULTS.md 2026-09-01 table; STATUS-ARCHIVE.md D17i stage 1 |
| 2 equivalent | % functions IDENTICAL round-trip, passes-on | 37.3% | 29.5% | 29.1% | docs/e2e/RESULTS.md 2026-09-01 table |
| 3 boots | RN-web / device boot | no — not attempted | no — not attempted | no — not attempted | docs/CONSOLIDATION.md item 31 (queued, not started) |
| 4 segregated | % instructions classified LIBRARY vs CUSTOM | 41.1% library | 26.5% library | not measured (`deps` >10 min, item 30) | STATUS-ARCHIVE.md "Classification: library vs custom" 2026-08-31; footnote local-corpus MetaMask 39.5%, Brex 25.1%, Discord 13.6% (same section) |
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
- M5 Pass ladder (readability) — in progress, 12/30 rungs merged
- M6 CLI + Tier 2 sweep (real bundles survive, clean round-trip) — not started

## Ladder — 12/30 rungs live

`loop-cond`, `for-header`, `switch-raise` (S1), `if-chain`, `label-clean`,
`expr-rebuild`, `global-access`, `call-shape`, `template-literal`,
`fn-naming`, `var-naming`, `jsx-recover` (opt-in `--jsx`).
Next 3 (batch 3): `default-params`, `destructure`, `spread-rest`.
Source: docs/specs/passes/00-LADDER.md; STATUS-ARCHIVE.md M5 section.

## Gate

`npm test` (this run, 2026-09-01): 1293 tests, 1276 pass, 0 fail, 17 skipped,
~106 s. CI: red-CI root cause (typecheck not run locally) fixed 2026-08-31 —
`npm test` now runs typecheck first; source: docs/CONSOLIDATION.md item 29.

## Open bugs — 20 open / 14 resolved, docs/BUGS.md (triaged 2026-09-01, QUEUE 4)

By cluster (open only): emit-shape 7, metrics 3, passes 3, real-app 2,
harness 2, deps 1, toolchain 2. Every open row has a status, cluster and
verdict; resolved rows (fixed/wontfix/d14-legit/duplicate) moved to
`## Resolved`. Gate: `tests/gate/docs/bugs-ledger.test.ts`.

## Blocked / needs Fred

- reg-split rung (real variable names) — blocked on docs/PUSHBACK.md P-6
  (spec §4.1 vs §1/§8 example contradiction).
- Device round-trip on a real app — needs a tablet attached.

## Queue — top 5 (docs/QUEUE.md)

1. STATUS.md → one screen (this task).
2. Sweep-on-every-merge + workflow rules into `docs/AGENT-WORKFLOW.md`.
3. BUGS.md triage: verdict + status per open row, cluster.
4. `deb` job server (Fred-requested small Node HTTP job runner).
5. Bulk signature DB round 2 on `deb` (100% module attribution goal).

Numbers are measured, not hoped — every cell cites its source file.
