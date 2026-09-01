# 2026-09-01 — QUEUE 4: BUGS.md triage — Sonnet, lean
Tokens 126k · tool calls 61 · landed green first try (over budget: 33 rows each checked against git log / tests).

33 rows → Open 19 / Resolved 14 (fixed 6, duplicate 3, d14-legit 2, wontfix 1). Open by cluster: emit-shape 7, metrics 3, passes 3, real-app 2, harness 2, deps 1, toolchain 1. Every open row has cluster + verdict + owner (QUEUE item). Gate test `tests/gate/docs/bugs-ledger.test.ts`. Overseer decision on the one "needs Fred": `structure` maxDepth platform-dependent guard = accepted documented risk (refuses cleanly with E_TOO_COMPLEX); stays open, low priority.
