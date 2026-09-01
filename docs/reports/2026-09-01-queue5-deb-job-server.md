# 2026-09-01 — QUEUE 5: deb job server — Sonnet, lean
Tokens 120k · tool calls 67 · landed green (agent) + 2 overseer fix commits.

`tools/deb/server.mjs` (POST /jobs, GET /jobs/:id → 40-line tail, FIFO, node_modules cache by lockfile hash, systemd user unit on deb:8787), `tools/deb/install.sh`, `tools/deb/run.sh -- <cmd>` (push branch → POST → poll → tail → exit code), `docs/DEB-CI.md`. Proof run exposed a Linux-only typecheck failure; root cause found by the overseer: cache layout broke symlinked `node_modules` resolution (TS walks up for an ancestor named `node_modules`). Fixed (dea83c0) + deterministic node 22 (ed4bae5). **Gate on deb: exit 0 in 41 s vs ~100 s local.** Agents now run heavy tests with one call.
