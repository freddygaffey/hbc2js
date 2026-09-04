# 2026-09-04 — spec 18 step 5: concurrency proof — SPEC 18 COMPLETE (lean Sonnet)

113k tokens, 61 calls. Commits 6c80598 + 92a7723, gate 2063/0 foreground.

- Harness: worker_threads, separate OS thread per writer, each own private :memory: .hbcproj (SQLite single-writer lock never engages — DB per-writer/operational per the design), + concurrent raw writeFindingShardForRid into ONE shared dir (literal concurrent-fs stress), incl. a batch both writers submit identically.
- PROVEN off the post-race shared dir: 0 id collisions (distinct (target,evidence) -> distinct content-hash id); 0 lost writes (every tuple has a valid shard); correct dedup (identical findings from both writers collapse to one shard). rebuild+verify ok:true after the race.
- Scale: gate tier 200 calls ~2s; sweep tier 1000-finding ~44s (HBC2JS_TIER=sweep).
- BUG filed (not fixed, out of scope): writeFindingShardForRid re-scans allRecords() per call -> O(n^2) export; BUGS.md row with fix verdict. Fix before heavy use.
- SPEC 18 COMPLETE — all §R4 steps 0-5 landed (export, rebuild/verify, write-path chained log, status/adopt/restore + verify-full fix, init+hook+CI, concurrency proof). Storage-integrity architecture built end-to-end.
