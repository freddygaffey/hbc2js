# 2026-09-03 — P2.1 query CLI + independent checker + measure (lean Sonnet)

222k tokens (OVER budget ~2x — outlier, rank in scoreboard), 142 tool calls, ~25 min. Commit 2179863.

- ArtifactService + `hbc2js query <verb>`: fn / who-calls / calls-from / string / string-grep / global-uses / native / module / source + name list/context (frame-queries shared with CLI path). All verbs cap-bounded (fn median 89B, who-calls 40B — far under budget). Staleness = hard error, no --force. --help fixed (P2.1a(d)).
- INDEPENDENT checker tools/artifact/check-index.ts (own disasm-level def-use walker, never semantic-walk.ts): rn-template --all = 0 unmarked-wrong across 4199 fns (15,546 calls / 1,722 globals / 35,854 string-uses). Checker self-test caught 2 bugs in the checker — the recount discipline works.
- Measured record: 6/8 targets PASS; 2 MISS reported honestly, not tuned away: build time 51.4% of decompile (target ≤25%), index size 64.5% of render (target ≤30%) — both filed as open BUGS rows per reviewer's renegotiate-openly rule.
- Tests A3/A4(reduced)/A6/A9 added; A5/A7/A10 deferred (budget); overlayHash-never-wired filed as BUGS row.
- Gate 1791/0 green.
