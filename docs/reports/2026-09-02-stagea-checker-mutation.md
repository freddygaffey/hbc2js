# 2026-09-02 — stage-A checker mutation tests (CONSOLIDATION 4 done) — Sonnet, lean
Tokens 200k · tool calls 111 · green.

13 active mutation assertions across 7 checkers. Caught all: if-chain(3), switch-raise(2), label-clean(1), template-literal(2), jsx-recover(2). HOLES (2, filed, test.todo): for-header/check.ts never validates form.step (block or offset); loop-cond/check.ts never validates form.kind (while/do-while) or form.negate. CONSOLIDATION 4 done. Across the whole campaign: 3 real checker holes found (expr-rebuild value — fixed; for-header step; loop-cond kind/negate) — mutation testing earned its place.
