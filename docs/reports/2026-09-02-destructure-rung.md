# 2026-09-02 — M5 rung 14 destructure (spec 16) — Sonnet, lean
Tokens 365k · tool calls 203 · green (over budget: intricate copy-chain shape).

Array `[a,b]=x` and object `{x,y}=o` (incl. object rest 3-arg copyDataProperties, object per-prop defaults) → ES destructuring patterns. F16 Pattern AST + printer + scope-check + pattern-aware var-naming. Sound checker (expand()-based effect-sequence diff + recompute-and-diff); rejects element-order swap and key rename. Fixtures 37/38/39 recover at v94+v99. Refused (v1 scope, BUGS): array per-element defaults, array rest, top-level (pc-region) destructuring. 14/30 rungs. Overseer note: merge needed manual BUGS.md rebuild (union-merge duplicated headers) + gate timing flakes were parallel-run load, not real.
