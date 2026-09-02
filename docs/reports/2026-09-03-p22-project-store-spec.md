# 2026-09-03 — P2.2 project-store spec (lean Fable)

50k tokens, 16 tool calls, ~7 min, clean first try. Commit a237fe8, docs/specs/11-project-store.md.

- Overlay WRAPPED not migrated (shipped name CLI + names.json stay byte-identical; generic RevisionStore<T> extracted behind the overlay's own green tests).
- 6 record types (names/comments/tags/bookmarks/findings/+conflict); findings require >=1 resolving evidence ref at write, live-checked at read; open->confirmed needs a dynamic (trace/fuzz/repro) ref.
- Orphan policy: FLAG-never-drop with last-known-context snapshot -> feeds P2.5 version-diff re-binding.
- Store: <artifact>/project/*.jsonl, (target,rid)-sorted for line-diffability; merge = line-union + explicit conflict records, refused across builtFor mismatch.
- Decision-8: integrity 100% resolve / read-cost caps (for-fn median <=1.5KB) / run-cost <=15% of index load, <=300B/record / held-out on react-navigation + a real version bump with zero silent drops.
- Open questions 1-4 queued for the Fable review gate (NOT launched — conserve mode, waits for Fred).
