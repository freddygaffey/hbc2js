# 2026-09-03 — stage-boundary reorder + reg-split DEFAULT-ON (lean Sonnet)

145k tokens (over ~110k budget — outlier), 100 tool calls, ~17 min, green first try. Commits 51c3be2, 206cb91, 76d31f2, 9b6e3c2.

- Root fix per Fred's approved design: jsx-recover moved into the structure-recovery block (it was last OVERALL, i.e. after renaming — the actual root cause); renaming block (fn-naming, reg-split, var-naming) now runs last. Existing after/before mechanism, no new framework. reg-split optIn -> default-on.
- DECISION D23: structure-before-renaming stage invariant + future matchers match def-use/value flow not register identity (extends CONSOLIDATION §B from tests to matchers; jsx-recover migration queued 2b).
- Verified: P-11b JSX repro passes v94/v99 w/ reg-split default; 16 rung tests + §10 fixtures 0-DIVERGENT; P-1 speed passes; full gate 1753/0. Three r\d+(_\d+)? widenings incl. var-naming red->green pinned as improvement.
- BUGS P-11b row -> Resolved (27 open/30 resolved); PUSHBACK P-11 CLOSED. Scoreboard: registers-named 3.2% -> 5.2% (construct corpus), opt-in rungs 2 -> 1 (jsx-recover --jsx only).
- Proof: rn-template fn#422 shows r0_2/r5_2 by default, no flags.
