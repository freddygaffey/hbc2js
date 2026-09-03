# 2026-09-03 — parallel decompile part 1: worker pool (lean Sonnet)

124k tokens, 77 calls, ~16 min. Commit 8d6b06d. Gate 1891/0.

- src/parallel/{pool,stage-a-worker,types}.ts + decompileParallel(); workers=1 IS the serial path (byte-identity by construction); hard gate test: 4-worker output === serial on rn-template; loud failure semantics.
- HONEST FINDING: stage-A = only ~10% of rn-template decompile time; stage-B (astPasses) + emitFunction = ~90%, serial, need the assembled child-spliced tree. End-to-end speedup on rn-template ≈ 0 (pool overhead ≈ saving). Design note: docs/perf/PARALLEL-DECOMPILE.md.
- DECISION NEEDED BY MEASUREMENT (queued): instrument stage shares on the real NSW bundle (43k fns, 662s) — if stage-B dominates there too, the win requires stage-B decoupling ("part 1.5", materially bigger); if pass cost is nonlinear in stage-A at scale, the pool already pays. Do NOT build part 1.5 before this number exists.
- Parts 2 (body-hash cache) + 3 (scoped single-fn decompile) remain queued; note part 3 shares stage-B's coupling problem.
