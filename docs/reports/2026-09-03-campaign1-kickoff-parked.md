# 2026-09-03 — construct campaign 1: runner built, launch PARKED (deb offline) (lean Sonnet)

70k tokens, 35 tool calls. Commit 0e13feb.

- tools/fuzz/campaign-runner.sh: chunked (500), resumable per-version state, work-range-only seeds (frozen eval range untouched), finds capped 200, wall/disk preflight caps; smoke-tested locally end-to-end incl. resume-no-op.
- Launch/status/resume/kill one-liners in docs/fuzz/CONSTRUCT-FUZZER.md "Campaign 1".
- BLOCKED: deb unreachable (agent sandbox AND orchestrator shell; Fred confirms "deb is gone"). PARKED — when deb returns: ssh preflight (VM presence per version MUST be verified, not assumed) then the documented launch one-liner. Round2b on deb also presumed dead with the box; do not restart without checking disk.
