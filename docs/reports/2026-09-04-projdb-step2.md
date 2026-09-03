# 2026-09-04 — project-DB step 2: hbc2js init + index row-sink (lean Sonnet)

128k tokens (over budget), 73 calls. Commit 6753be1. A2 green (10/10 projdb).

- src/artifact/index-rows.ts: buildIndexRows() runs the SAME builders as write.ts (functions/modules/semantic/strings/native/ranges/manifest) into one bundle, no JSONL serialization — shared reuse point.
- src/projdb/ix-write.ts: writeIxRows (ix_* inserts; CalleeRef as decimal-string to match v_json_calls GLOB; len derived for non-truncated strings) + initProjectDb (meta + log gen-1) in one transaction.
- src/cli.ts: `hbc2js init <bundle.hbc> [--out]` — writes split tree then project.hbcproj; refuses (exit 3) if it exists; cleans partial on throw. JSONL writers untouched, no dual-write.
- Gate: 4 fails, ALL tests/gate/harness/ladder-* = concurrent P-14 agent's in-flight ladder.ts WIP, NOT step 2 (disjoint). Targeted projdb/split/artifact/docs all green. Push HELD until P-14 lands + clean full gate.
