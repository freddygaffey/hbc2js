# 2026-09-04 — spec 18 step 1: hbcproj rebuild + verify (lean Sonnet)

133k tokens (over budget), 59 calls. Commit 7e9410b, gate 2031/0 foreground.

- rebuild.ts: rebuildProject regenerates revisions/d_*/log FROM analysis/** + log/*.jsonl alone (recovery direction). Active shards reinserted at original rid/ts/prov in the correct slot (rebuilt DB live-queryable). Historical superseded/reverted entries become inert cleared=1 placeholders (content not recoverable from step-0 export format — closed by step 2's true chained log).
- verify.ts: fast = per-shard hash self-consistency + stateBinding.dbVersion staleness + log chain continuity; --full adds DB<->shards agreement + rebuild round-trip.
- PROVEN: round-trip byte-identical (§R3 metric 1); corrupted/hand-edited shard -> classified hand-edit, verify FAILS; unchanged-but-stale shard -> classified lag, verify PASSES (lag never fails). The §8 data-loss guard works.
- NEXT (§R4): step 2 write-path export + true per-write chained log; step 3 status/diff/adopt/restore; step 4 init+hook+CI; step 5 concurrency proof.
