# 2026-09-02 — construct fuzzer implementation (lean Sonnet)

166k tokens (OVER the ~120k budget — outlier, flag in scoreboard ranking), 118 tool calls, ~33 min. Commit 3051cf7.

- src/fuzzgen/ (grammar+mutation generator, ddmin minimiser, signature dedup, enforced work/eval seed ranges), tools/fuzz/construct-fuzz.mjs driver (fuzz-matrix/1 reports), tests/fuzz T2-T4 green, docs/fuzz/CONSTRUCT-FUZZER.md, reports/ gitignored (E4).
- Smoke (60 programs, v94+v99): 51 pass, 7 divergent, 2 error, 0 inconclusive — 7 DISTINCT signatures = REAL FINDS. 2 BUGS.md rows filed (param-names-in-TypeError-text + 5-signature placeholder w/ repro command). One plausibly D14-legit.
- PUSHBACK P-12: spec's 4-oracle ladder roundtrip false-positives on helper-injecting constructs (function-count mismatch, e.g. 07-for-of-iterable 3 vs 8); resolved to syntax+trace+fuzz for traced versions per src/harness/tiers.ts precedent; v98 roundtrip-only lane unchanged. RATIFIED by orchestrator (see spec 09 Review responses).
- Deferred: live minimise() wiring in the driver (library tested, T3); app-gen fuzzer (§2); held-out set (§3).
- Gate at landing: 3 fails, all P-11b's concurrent r\d+ WIP (jsx-recover/var-naming), none in fuzz/docs paths. Push deferred to P-11b landing.
