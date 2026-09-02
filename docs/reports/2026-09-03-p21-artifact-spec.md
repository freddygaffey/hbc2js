# 2026-09-03 — P2.1 artifact-format + xref spec (lean Fable)

47k tokens, 15 tool calls, ~5 min. Commit ef6b7f5. docs/specs/10-artifact-format.md.

- Two-layer index (semantic keyed to fnIndex/binding-ids, render-independent; presentation ranges.jsonl hash-tied per render) = rename-survival by construction. JSONL sorted+schema-headed (grep/diff-able, feeds P2.5). ? edges first-class w/ mandatory why; staleness = hard error, no --force; truncation/completeness stated in every answer. P2.1a(b) queries (name list, context) folded in as live warm-frame queries.
- Decision-8: 0 unmarked-wrong edges on 200-fn sample (check-index.ts); per-verb token caps (who-calls med <=2KB, context <=40 lines; measure.ts); build <=25% of decompile time, index <=30% of source bytes; held-out = react-navigation bundle + local-corpus spot-check, tuned only on rn-template+fixtures.
- A1 self-consistency test shipped verbatim in §7 (write-scope restriction); impl step 0 materialises it unchanged.
- 4 open questions -> review gate (launched same morning).
