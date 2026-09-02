# 2026-09-03 — fuzz divergence triage (lean Sonnet)

166k tokens (outlier), 110 tool calls, ~32 min. Commit cfdf952.

- 4/5 live signatures = ONE harness gap: ladder.ts's D14 VM-agrees override is gated on curated fixture NAMES (reference-policy KNOWN_DIVERGENT_FIXTURES), so nameless fuzz programs get false DIVERGENT even when candidate==VM byte-for-byte (same root cause CONSOLIDATION 26 named for 20-symbol-keyed-properties, now confirmed general). BUGS harness row.
- 1 REAL find: v99 seed 777007 async fn + shared exception-handler range, candidate-vs-VM disagreement; minimised 75->37 lines via NEW live minimise callback (tools/fuzz/minimise-live.mjs — the deferred wiring, now landed); fixture tests/fixtures/adversarial/43-fuzz-async-guard-shared-range + semantics BUGS row.
- v94 ERRORs: that hermesc has NO class support; mutate.ts lacks versions.txt gating — harness row w/ concrete fix.
- TypeError-name row: wontfix ceiling (build.sh never passes -g; names absent from input). Filed separately: comparing engine TypeError message TEXT is unsound for synthesised-name decompilers — recommend (constructor, thrown-vs-not) or identifier masking.
- BUGS now 30 open / 31 resolved (ledger gate green); also repaired a whitespace break in a concurrent append.
