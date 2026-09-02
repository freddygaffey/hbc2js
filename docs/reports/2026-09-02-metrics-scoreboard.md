# 2026-09-02 — metrics scoreboard collector (lean Sonnet)

97k tokens, 67 tool calls, ~12 min, green first try. Commits 0b8b07c, 751102a.

- Wrote tools/metrics/collect.mjs fresh (salvage candidate app-metrics.mjs on worktree-agent-a99810bd07c13c086 is a different, heavier bundle-level tool — kept as future CI candidate, noted in docs/METRICS.md).
- Baseline row (BEFORE reg-split default-on): 493 commits | 112 today | 17/30 rungs (2 opt-in) | gate 902 | BUGS 25 open/29 resolved | src 25,983 LOC / 24.3% comments | tests 18,151 LOC | registers-named 3.2% (cheap construct-corpus method; bundle-level 4.1% figure = TODO) | tokens/item median 134.5k | DIVERGENT + corpus matrix n/a (reserved for Lane T).
- Also fixed stale docs/test-count-baseline.json gate value 867 -> 902 (real count, exact test regex).
- Gate: 1745 pass / 0 fail / 3 pre-existing skips.
