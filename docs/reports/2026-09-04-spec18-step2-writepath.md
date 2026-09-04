# 2026-09-04 — spec 18 step 2: live write-path + true chained log (lean Sonnet)

158k tokens (over budget — session overrun pattern), 71 calls. Gate fail 0 (parse/fuzz flake verified isolated). Survived an accidental kill + Fred resume.

- export.ts: exportWriteEffect(db, dir, rid) materializes only the affected shard + appends one hash-chained log entry (chains from tip, not genesis). annotate entries carry slot+value (via immutable revisions/d_* rows); revert entries carry reactivates.
- rebuild.ts: uses the new fields -> superseded/reverted entries reconstruct REAL content (per-slot last-rid map), not inert placeholders; old-format entries fall back (backward compatible).
- service.ts: projectDir + exportWrite(rid) hook called from all 6 DB write verbs after commit (DB-first, then shard+log reflect committed state).
- PROVEN: rebuild-after-supersede recovers superseded history; rebuild-after-revert-reactivate restores prior value; live set/supersede/revert = exactly one chained entry each, verify stays green.
- FLAGGED FOLLOW-UP (fold into step 3): verify --full's dbShardsAgree blind-diffs a uniform bulk re-export vs committed shards; after incremental writes, committed shards carry older stateBinding.dbVersion -> false mismatch. Make --full lag-aware like the fast path.
- NEXT (§R4): step 3 status/diff/adopt/restore + verify --full fix; step 4 init+hook+CI; step 5 concurrency proof.
