# 2026-09-01 — QUEUE 3: sweep on merge + landing rules — Sonnet, `lean` agent type (first use)
Tokens 35k · tool calls 25 · 4 min · landed green first try.

sweep.yml: `push: {branches: [main]}` + `concurrency: sweep-${{ github.ref }}` cancel-in-progress + ci.yml-shaped hermesc cache. AGENT-WORKFLOW.md "Landing rules" (12, 16, 17, 20). Lean type vs general-purpose+budget: 35k vs 96–102k for comparable small tasks.
