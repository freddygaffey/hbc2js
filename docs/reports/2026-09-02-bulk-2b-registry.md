# 2026-09-02 — bulk sigdb round 2b (registry-driven) — Sonnet, lean
Tokens 126k · tool calls 84 · green.

`candidates.mjs --registry`: npm search (keywords react-native/expo + name prefix) → 11,146 distinct packages → rank by last-month downloads → top N × versions from last 24 months − already-fingerprinted. `round2b-runner.sh` chains gen → continue-bulk.sh (round2b tag, 16 parallel, per-package cleanup). Launched on deb (ssh -f + setsid); download-ranking was still running at handoff (candidate list not yet written, so no attribution number yet). Multi-day run; status/resume/widen commands in docs/DEPS.md Round 2b. Ops note: detached ssh jobs need `ssh -f` + `setsid`; `pkill -f` must bracket-escape its own pattern.
