# 2026-09-03 — perf part 3: expressionOnlyCheck incremental (lean Sonnet; scope amended mid-task twice by Fred's directives)

206k tokens (largest overrun of the day — task predates the tightened scoping), 127 calls, ~54 min. Commit 32548da.

- Incremental read-before-def check: per-lineage cache, interpolated persistent position keys, carried violating-set (subtlety of the old algorithm faithfully reproduced + proved in comments). defUse untouched for other callers (shared defUseWalk core).
- EQUIVALENCE PROVED: old algorithm kept as reference; probe compares verdicts on EVERY real check call across the whole fixture corpus (~2500 calls) — green; the differential test found 2 real bugs in the new implementation pre-landing.
- Microbenchmark: quadratic killed (96.2ms -> 8.8ms at N=8000, near-flat). rn-template unchanged (this check isn't its dominant cost — consistent with Fred's profile: whole-file 600s = naming-pass taken-set, separate parked item). NSW measurement skipped per Fred.
- HBC2JS_TIMINGS=1 stage timers added (parse/analyse/stageA/stageB/emit).
- Landing exposed 2 red docs gates from the PREVIOUS landing: STATUS 101-split-lines and baseline 948 vs actual 929 — the deps agent bumped the baseline AFTER its gate run without re-running (chain-after-gate). Orchestrator fixed both (trim + correct baseline to real 929; growth 902->929 additions-only). LESSON re-learned: the landing gate must run on the exact final commit.
