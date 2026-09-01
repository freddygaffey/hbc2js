# 2026-09-02 — for-header/loop-cond checker hole fixes — Sonnet, lean (+overseer follow-up)
Tokens 97k · tool calls 39 · green (after overseer reworded 2 messages that false-tripped imports.test's regex).

for-header/check.ts and loop-cond/check.ts re-run match() and compare re-derived step/kind/negate against after.form; reject wrong step block, flipped while/do-while, flipped polarity. All fixtures accepted. 3 mutation-found checker holes now all fixed. Fragile imports.test regex filed as a BUGS row.
