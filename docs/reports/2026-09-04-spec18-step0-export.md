# 2026-09-04 — spec 18 step 0: hbcproj export (lean Sonnet)

144k tokens (over budget — session-wide overrun pattern), 82 calls. Commits (2), gate 2023/0 foreground.

- src/projdb/export.ts: exportProject(db, dir) + findingContentId(target, evidence). CLI `hbcproj export`.
- Shards: analysis/names/<module>.json, analysis/annotations/<module>.json, analysis/findings/<content-hash-id>.json, log/<date>.jsonl (hash-chained). Module sharding via ix_functions.module -> ix_modules.file, _unassigned fallback.
- PROVEN: content-hash finding ids; second export on unchanged DB = 0 written, byte-identical (no-op); id stable across status transition, same shard rewritten in place. CLI e2e test via init+export.
- Documented step-0 simplification (deferred to §R4 step 2): bulk export records each shard's CURRENT post-export hash, not a true per-write historical hash; empty shards:[] for a log entry whose value was later superseded to a different id. Fixed when the write-path/true-chained-log lands.
- NEXT (§R4): step 1 rebuild+verify (JSON->DB regen, hash+chain, --full); step 2 write-path export + true chained log; step 3 status/diff/adopt/restore; step 4 init+hook+CI; step 5 concurrency proof.
