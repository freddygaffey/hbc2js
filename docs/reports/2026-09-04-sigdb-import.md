# 2026-09-04 — sigdb SQLite import (lean Sonnet; resumed from spend-limit WIP)

100k tokens, 45 calls. Commit 3c0bfbe (built on WIP 54fbb14's sigdb-schema.sql).

- src/deps/sigdb-sql.ts: openSigDb (schema-version guard), insertFingerprint (upsert + function-shape interning, 24-hex hash validation, capture-column backfill), quarantine, rebuildDerived (rollups + hash_stats).
- tools/pkgsig/sigdb/import-json.mjs: sha256 import_log skip (idempotent), same-name-diff-sha refuses, 200-file atomic batches, VACUUM, --verify/--verify-only.
- Completeness check: re-enumerates source (no hardcoded count), zero error rows, index.json reconciliation, seeded 1% + all-baselines round-trip via an INDEPENDENT read path (only openSigDb shared writer<->verifier, per review item 6).
- 6/6 fixture tests pass. NOT yet run against deb's real 71,300 store (targets 1/3 unmeasured — orchestrator will run it as background deb compute).
- Orchestrator note: fixed docs/STATUS.md 104->100 (import agent added a line over the one-screen cap; trimmed stale fuzzing-lane queue block).
- Remaining sigdb steps: write-path dispatch, export/read-side (spec 15 §10 steps 4-6).
