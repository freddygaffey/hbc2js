# 2026-09-02 — M5 rung 15 spread-rest (spec 17) — Sonnet, lean
Tokens 341k · tool calls 250 (over budget: F17 framework ripple + a real bug). green.

`__hbc_b_arraySpread`/`apply`/`copyRestArgs`/2-arg copyDataProperties → `[...x]`, `f(...a)`, `{...o}`, `...rest`. F17 spread AST node + object spreadProp + printer (touched 10 passes). Sound checker rejects element-order swap and spread→non-spread. Metric: 40/41 100% helper-call removal at all versions; 42 rest-param recovered at v84/94/96, v98/v99 gap (orphan-function framework limit, same as default-params, BUGS). FOUND+FIXED a real trace-DIVERGENT bug: match.ts trailing-setup over-absorption deleted statements needed by later code (consumedUpTo tracker). 15/30 rungs.
