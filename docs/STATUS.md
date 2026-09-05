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
| 5 readable | var-naming: registers named | 20.2% (bundle) / 13.1% (57-fixture matrix v94+v99 base) / 10.0% (full matrix) | – | – | docs/specs/passes/19-reg-split.md §9 Q4 compound upgrade, 2026-09-02 (was 4.1%/3.4%/3.1% pre-upgrade, STATUS-ARCHIVE.md `var-naming` R5 2026-08-31); short of the reg-split spec's 15% construct-corpus target on the gate subset, well past it on the RN bundle |
| 5 readable | jsx-recover: element sites recovered | 9.7% (15/154) | – | – | STATUS-ARCHIVE.md `jsx-recover`, 2026-09-01 |
| 5 readable | template-literal: sites converted | 99.45% | – | – | STATUS-ARCHIVE.md `template-literal`, 2026-09-01 |
| 5 readable | surviving `rN` per 1k lines | – | – | – | not yet tracked (no docs/reports entry) |

## Stage 2 — analyst/LLM annotation layer (P2.x, docs/QUEUE.md STAGE 2)
| item | status | numbers | source |
|---|---|---|---|
| P2.1 artifact format | complete | index ≤25% decompile time, ≤30% rendered bytes, query costs under cap — rn-template + held-out react-navigation | docs/specs/10-artifact-format.md §5; docs/reports/2026-09-03-p21-*.md |
| P2.2 project store | complete | decision-8 all 4 MET: integrity 100% (120/120 rn-template, 120/120 held-out react-navigation, reject-gate live, 0 invalid-on-disk); read cost `for-fn` median 182B (≤1536B); run cost load 0.4ms=0.8-2.5% of artifact load (≤15%), 292-295B/record (≤300B); held-out orphan check (rn-template noopt-debug vs release build, no network): 4/60 vanished fns → 16/16 dependent records flagged orphaned w/ ctx, 240/240 rows survived (zero silent drops) | docs/specs/11-project-store.md §5; `tools/project/{check-store,measure}.ts`; docs/reports/2026-09-03-p22-step[0-8].md |
| P2.3 secrets scan | classify+service+measure done, targets MET, CLI wiring pending | precision 100% (≥95%), FP 0.38/1k tuning, 1.41/1k held-out (≤5/≤8) | docs/specs/12-string-secrets.md; docs/reports/2026-09-03-p23-finisher.md |
| P2.4 reuse-validation (Semgrep/OSV/manifest) | steps 0-1 done (licensing re-verified, tool-presence probes, seeded fixture, T-L/T1 green, T2-T8 red-skipped pending lane impl); lanes O/S/M not implemented | T-L/T1 6/6 pass; T2-T8 skip-with-reason (`HBC2JS_REQUIRE_ORACLES=1` fails them) | docs/specs/13-reuse-validation.md §9 steps 0-1 |
| P2.6 project DB (`.hbcproj`) | steps 0-1 done: A1 (§7) green — schema self-consistency on a hand-written sample; steps 2-8 (init, annotation stratum, query paths, export/import, names-in-DB, verbs, checker) not started | A1 5/5 pass | docs/specs/16-project-db.md §8 plan; `src/projdb/{schema.sql,db.ts}`; `tests/projdb/` |

## Milestones

- M0 Research (toolchain, prior art, corpus candidates) — done
- M1 Parser (all 5 layout classes, v84/94/96/98/99) — done
- M2 Disassembler (100% match vs `hermesc -dump-bytecode`) — done
- M3 Test harness (trace runner + recompile round-trip) — done
- M4 Baseline (CFG + structurer + emitter) — done, 501/501 gate, 0 DIVERGENT
- M5 Pass ladder (readability) — in progress, 18/30 rungs merged (1 opt-in)
- M6 CLI + Tier 2 sweep (real bundles survive, clean round-trip) — not started

## Ladder — 18/30 rungs live (1 opt-in)

`loop-cond`, `for-header`, `switch-raise` (S1), `if-chain`, `try-shape`,
`label-clean`, `expr-rebuild`, `global-access`, `call-shape`, `default-params`,
`destructure`, `spread-rest`, `template-literal`, `jsx-recover` (opt-in
`--jsx`), `try-clean`, `fn-naming`, `reg-split`, `var-naming`. D23 (2026-09-03,
docs/DECISIONS.md) reorders the registry: every structure-recovery rung
(through `jsx-recover`) now runs before the renaming block
(`fn-naming`/`reg-split`/`var-naming`) — `reg-split` is now **default-on**
(P-11/P-11b resolved, docs/PUSHBACK.md P-11 closed, docs/BUGS.md P-11b
row resolved). `try-shape`/`try-clean` (spec 22, 2026-09-05) strip redundant
`__pc`/`__exc` scaffolding (PUSHBACK P-18).
Next: var-naming compound -> literal-forms / arguments-form / for-in/for-of.
Source: docs/specs/passes/00-LADDER.md; STATUS-ARCHIVE.md M5 section.

## Gate
`npm test` (this run, 2026-09-04): 1957 tests, 1951 pass, 0 fail, 6 skipped,
~120s. Typecheck runs first (CONSOLIDATION.md item 29, fixed 2026-08-31).
+5 tests this run: `tests/projdb/schema.test.ts` (spec 16 A1).
Sigdb v3 import step landed 2026-09-03 (docs/specs/15-sigdb-schema.md §3):
`src/deps/sigdb-sql.ts` (schema/writer) + `tools/pkgsig/sigdb/import-json.mjs`
(idempotent, resumable, 4-part completeness check) — not yet run against the
real `deb` 71,300-file store (§7 targets 1/3 unmeasured). Write-path dispatch
landed 2026-09-04 (§4/§10 step 6): `src/deps/db.ts`'s `writeSignature`/
`loadSignatures` and both named call sites (`confirm.ts` via `HBC2JS_SIGDB=1`,
`tools/pkgsig/bulk/build-one.mjs`) route to a `.sqlite` sigdb v3 file when
one is named, JSON otherwise (default, unchanged) — the A8 acceptance test
(full `--json` DepsReport parity) is still open, spec-owned.
## Open bugs — 24 open / 23 resolved, docs/BUGS.md (triaged 2026-09-01, QUEUE 4; +2 rows 2026-09-02 destructure landing; +1 row 2026-09-02 spread-rest landing)
By cluster (open only): emit-shape 7, metrics 3, passes 4, real-app 2,
harness 2, deps 1, toolchain 2. Every open row has a status, cluster and
verdict; resolved rows (fixed/wontfix/d14-legit/duplicate) moved to
`## Resolved`. Gate: `tests/gate/docs/bugs-ledger.test.ts`.
## Blocked / needs Fred
- reg-split rung — **RESOLVED 2026-09-03** (D23, docs/DECISIONS.md):
  default-on since the stage-boundary reorder. `jsx-recover` was the real
  blocker (P-11b) — it is a structure-recovery rung that the old registry
  order ran last overall (after `reg-split`/`var-naming`), so `reg-split`'s
  renaming corrupted the shape `jsx-recover`'s matcher keyed off. Moved
  `jsx-recover` to the end of the structure-recovery block instead (still
  before the renaming block, still opt-in `--jsx`); `reg-split` no longer
  runs before any structure rung. Verified: both existing
  `jsx-recover.test.ts` JSX-recovery assertions on `59-jsx-runtime-calls`
  v94/v99 pass with `reg-split` default-on; `reg-split`'s 16 rung tests and
  its spec's five §10 target fixtures stay 0-DIVERGENT; P-1's pipeline-speed
  ceiling holds; full `npm test` 1753/1753 pass. docs/BUGS.md's P-11b row
  moved to Resolved; docs/PUSHBACK.md's P-11 follow-up closed.
- Device round-trip on a real app — needs a tablet attached.
## Queue — top of docs/QUEUE.md
DB MIGRATION (Fred 2026-09-04): sigdb -> SQLite (spec 15; import landed);
project DB (spec 16, `hbc2js init` — one versioned SQLite over P2.1+P2.2,
JSON as a generated view). Then MCP-harness business-logic spec, then the
fix-wave on the 191 real fuzz signatures. Stage-2 lanes S/M + P2.5 remain.
Numbers are measured, not hoped — every cell cites its source file.