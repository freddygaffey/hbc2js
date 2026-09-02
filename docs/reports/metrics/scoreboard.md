# Metrics scoreboard

Append-only, one row per day, produced by `node tools/metrics/collect.mjs` at landing time.
See `docs/METRICS.md` for column definitions and TODOs on the `n/a` columns
(trace-oracle DIVERGENT count and corpus pass-matrix — reserved, wait on the fuzzing lane;
registers-named % here is the construct-corpus figure, not the heavier rn-template-bundle figure).

| date | commits total | commits today | rungs live/target | gate tests (baseline) | BUGS open | BUGS resolved | src code LOC | src comment % | tests LOC | registers-named % | tokens/item median (k) | trace-oracle DIVERGENT | corpus pass matrix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-02 | 516 | 135 | 17/30 (1 opt-in) | 902 | 27 | 30 | 26271 | 24.5% | 18318 | 5.2% | 134.5 | n/a | n/a |
