# 2026-09-02 — for-header/loop-cond checker hole fixes — Sonnet, lean
Tokens 97k · tool calls 39 · green first try.

for-header/check.ts now re-runs match() and compares re-derived init/step {cfgBlock, from} against after.form; loop-cond/check.ts compares re-derived kind/negate. Rejects: wrong step block, flipped while/do-while, flipped polarity (3 un-todo'd). All fixtures still accepted. Both BUGS rows → Resolved. Campaign total: 3 checker holes found by mutation testing, all 3 now fixed.
