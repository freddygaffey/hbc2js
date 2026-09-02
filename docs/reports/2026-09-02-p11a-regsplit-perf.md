# 2026-09-02 — P-11a reg-split perf (lean Sonnet)

100k tokens, 50 tool calls, ~12 min, green first try. Commit 9110fb9.

- Real bottleneck (via --cpu-prof, not the P-11 guess): check.ts reachesSeq called uncached defUse(fnBody) per (def,use) pair = O(defs x uses x body-size); fixed by threading caller's defPositions. Also fixed match.ts R-catch pre-coarsening O(regs x tries) -> single global merge-scan. (R-loop coarsening was already fine.)
- Measured (P-1 method, best-of-3, reg-split forced on): 13.6x -> 7.7-10.7x, all under the 12x ceiling. Isolated reg-split CPU on rn-template ~7.2s -> ~3.15s.
- Soundness unchanged: 16 rung tests pass, §10 fixtures 0-DIVERGENT, no assertion touched. optIn still true (flip = P-11b).
- PUSHBACK.md P-11 row updated with numbers + method.
