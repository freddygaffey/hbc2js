# 2026-09-03 — fuzz campaign 1: 40k programs run, summary lost at write, finds intact

~5h background compute (local M5, one core). Driver crashed at the final JSON.stringify (report too large — BUGS.md 2026-09-03 harness row); exit-1 masked by the orchestrator's tail pipe.

- SURVIVED: reports/fuzz/finds/ — 201 deterministic failing programs: v84 50, v94 46, v96 45, v98 1 (roundtrip-only lane), v99 59. Every find reproducible by seed.
- LOST: the aggregate pass/divergent matrix (cells) — NOT recomputable without re-run; find totals above are the divergent+error per-version counts out of 10k each (~0.5% per traced version).
- Scoreboard DIVERGENT column stays n/a until a post-fix campaign writes a real matrix.
- HELD (Fred's hold mode): driver streaming-write fix, campaign re-run, and the 201-find triage all wait for go.
