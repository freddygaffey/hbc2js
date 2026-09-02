# 2026-09-02 — M5 rung 16 optional-chain (spec 18) — Sonnet, lean
Tokens 254k · tool calls 167 · green.

`x == null ? undefined : x.y` guard runs → `x?.y`, `x?.()`, `x?.[]`, `??`. F18 optmember/optcall AST + printer; effectSequence gained guardDepth (D14 short-circuit order). Sound checker: rejects ?.→. downgrade and ?? fallback swap. Fixture 48 v94 fully recovered (0 residual guards). v99 edge: compiler elides a chain's own base guard when a sibling chain already proved the register non-null — distinct shape, not in spec; shipped v94, BUGS row for v99. Registered after call-shape, before var-naming. 16/30 rungs.
