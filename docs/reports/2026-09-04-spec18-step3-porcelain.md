# 2026-09-04 — spec 18 step 3: status/diff/adopt/restore porcelain + verify--full fix (lean Sonnet)

185k tokens (OVER budget — the impl-agent overrun pattern persists all session; 110k briefs consistently land at 130-185k on these correctness-critical tasks; flagging, not failing). 95 calls. Gate 2054/0 foreground.

- threeway.ts: classifyThreeWay reuses step-1 checkShard (ok/lag/hand-edit/corrupt) + one distinction — hand-edit whose dbVersion is ALSO behind = conflict (refused w/o --force). No separate base table needed: the shard's own stateBinding.dbVersion IS the base. Clean.
- adopt validates like an MCP write: parses, re-runs spec-11 §4.1 evidence gate (ArtifactEvidenceResolver over ix_ tables, no live artifact), folds via the same dbSet* verbs + exportWriteEffect -> re-locked/chained. PROVEN: DB authoritative after adopt, one chained log row, invalid-evidence finding rejected with ZERO db writes (atomic), malformed shard rejected. restore discards to DB state.
- verify --full FIX: diffDirs gets mode (shard-json/log-jsonl) stripping volatile stateBinding/hash-chain before compare -> no false positive after incremental writes; genuine divergence still caught (regression test).
- BONUS bug caught+fixed: init's ridless log rows hashed Number("null")=NaN -> UNIQUE rid collision in rebuild; non-annotate/revert ops now short-circuit to ridless insert.
- NEXT (§R4): step 4 init + pre-commit hook + CI (§11); step 5 concurrency proof (metric 3).
