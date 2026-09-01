# 2026-09-02 — expr-rebuild checker value hole fix — Sonnet, lean
Tokens 63k · tool calls 40 · green first try.

`src/passes/expr-rebuild/check.ts` now re-derives the site and calls the writer's own exported `rewrite()` to independently recompute the expected `after`, then diffs statement-by-statement — same recompute-and-diff pattern as global-access/call-shape. Rejects: wrong folded constant, wrong operator, wrong operand register (3 active mutation tests, was 1 todo). All 73 expr-rebuild fixtures still accepted. BUGS row → Resolved.
