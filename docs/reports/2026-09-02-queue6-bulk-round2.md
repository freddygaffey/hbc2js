# 2026-09-02 — QUEUE 6: bulk signature DB round 2 on deb — Sonnet, lean
Tokens 157k · tool calls 93 · green.

`tools/pkgsig/bulk/candidates.mjs` (truth files + NSW hints + RN 0.73–0.76 + 141 curated ecosystem packages − round-1 index → 92 pkgs / 136 pairs / 544 jobs) and resumable `continue-bulk.sh` (nohup, fnm node 22, incremental assemble). Ran to completion on deb in ~14 min: 32,355 → 32,654 signatures. Attribution (bulk DB alone, no curated starter): Service NSW modules 14.26% → 15.90%, instruction-weight 4.46% → 4.83%, names 386 → 411; rn-template unchanged. Conclusion: coverage-limited — the candidate list must come from the npm registry (thousands of packages, all recent versions), not a hand list. Fixed on the way: ssh tilde expansion; node 18 default on deb; stale deb checkout.
