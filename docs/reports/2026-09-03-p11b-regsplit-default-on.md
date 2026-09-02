# 2026-09-03 — P-11b reg-split default-on: BLOCKED, correctly reverted (lean Sonnet)

87k tokens, 54 tool calls, ~19 min. Commits 71ddf9c (WIP, prior cut-off agent) + 1a44914.

- Flip attempted on WIP 71ddf9c; gate isolated the real blocker: with reg-split default-on, jsx-recover STOPS recovering on 59-jsx-runtime-calls (v94+v99) — reg-split's per-store renaming (r3/r3_2/r3_3) breaks jsx-recover's (or object-literal-merge's) def-use match. A rung genuinely misbehaving on split registers = the brief's STOP condition; the agent reverted optIn to true rather than loosen anything. Exactly the wanted behaviour.
- Kept: harmless r\d+(_\d+)? widenings in call-shape/expr-rebuild/global-access tests. Reverted: flip + default-order assertions.
- BUGS.md row (open, 2026-09-02 P-11b) with repro + fix options: (a) make jsx-recover's matcher see through reg-split renaming, or (b) reorder reg-split AFTER jsx-recover, then re-verify 59-jsx-runtime-calls before re-flipping.
- var-naming red->green: never reached (pre-existing passing state, untouched).
- Gate 1753/0 green; reg-split 16 rung tests + P-1 speed green; scoreboard row appended (registers-named 3.2%, unchanged — reg-split still opt-in).
