# 2026-09-03 — gate decompile cache, sweep F2 (lean Sonnet)

114k tokens, 81 tool calls, ~29 min, checkpointed at budget. Commit 5e33375.

- Empirically confirmed node --test = process-per-file, so built an on-disk cache (tests/support/decompiled.ts): v8-serialize blobs keyed by bundle bytes + stable options + src/**/*.ts size+mtime fingerprint (any source edit invalidates). Closure-bearing HbcModule rebuilt exactly on hit (~80ms vs 5-8s; 70-100x per call).
- 8 files converted import-alias-only (split/artifact/jsx-recover suites); pipeline-speed untouched (deliberately fresh); sweep-gated tools/*.mjs wrappers excluded (outside write scope).
- HONEST caveat: clean isolated before/after suite wall-time missing (baseline 122.8s; after-run contaminated by suite growing 1521->1805 mid-measurement). Per-call number is the evidence.
- Handoff: readFileSync fold (20 sites), isolated re-measure via background run, tools-wrapper caching for test:sweep.
- Gate 1805/0 at landing.
