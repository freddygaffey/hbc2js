# 2026-09-03 — P2.2 project-store spec review gate (lean Fable) — APPROVED

57k tokens, 15 tool calls, ~5 min. Commit 8184329.

- Verdict APPROVED, six in-place edits E1-E6; nothing design-blocking.
- Rulings: names split stands (no relocation flag); comment re-anchoring = fn-level + range-stale flag (line-level waits for P2.5); v1 reserves tags, proposers plug in later via source:"tool" provenance; cross-decompile merge REFUSED (fn:N may be a different function across bytes — silent wrong re-attachment undetectable).
- Key fixes: orphan status live-computed with write-time ctx snapshot (append-only preserved); comments excluded from canonical render (staleness model intact); §6 step 0 now owns the P1-P3 test harness (spec commit was docs-only).
- Impl cleared to launch AT STEP 0 (test harness + sample store), then step 1 = RevisionStore<T> extraction with overlay tests staying green as the behaviour-preservation guard.
