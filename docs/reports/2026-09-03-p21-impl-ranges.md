# 2026-09-03 — P2.1 impl: renderer range hook + ranges.jsonl (lean Sonnet)

132k tokens (over budget — outlier #3 today), 88 tool calls, ~13 min. Commits 9bae684, c02d056.

- Real onFunctionRange hook in src/emit/print.ts (O(n) prefix-sum over the printer's line array), wired via src/split; ranges.jsonl per §2.7, header tied to render hash. Inline function-expressions deliberately omitted + documented (truth-first, not fabricated).
- Validated on rn-template: 4199 fns / 435 modules / 4125 ranges (gap == legitimately factory-less fns); sampled rows read back against emitted files match exactly.
- New tests/artifact/build.test.ts: A2 + a ranges truth test that re-reads real output lines.
- Deferred cleanly at a commit boundary: calls/strings/globals/native indexes + A3-A10 (next agent; handoff notes in report).
- Gate at landing: 1770/1773, 0 fail (incl. pipeline-speed passing; var-naming WIP present in tree).
