# 2026-09-02 — mutation-test the pass checkers (CONSOLIDATION 4) — Sonnet, lean
Tokens 126k · tool calls 70 · green.

Hand-built mutation tests (Stryker not a dep): feed each checker a real (before, after) then a plausibly-wrong `after`, assert rejection. `tests/gate/passes/checker-mutation.test.ts`. Caught: var-naming (2/2), fn-naming (1/1), global-access (1/1), call-shape (1/1). HOLE: expr-rebuild/check.ts accepts a wrong folded CONSTANT — it checks classification + read/write-count delta but never compares the substituted value; filed BUGS (cluster passes), pinned test.todo. Not probed (budget): 5 stage-A CFG checkers (need block-bearing fixtures); template-literal/jsx-recover read as robust (byte-diff the recomputed rewrite) but not empirically mutated. CONSOLIDATION 4 in-progress.
