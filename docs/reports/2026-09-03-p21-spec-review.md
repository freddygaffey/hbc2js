# 2026-09-03 — P2.1 spec review gate (lean Fable) — APPROVED

55k tokens, 12 tool calls, ~4 min. Commit 89eaf24. Impl step 0 cleared.

- Rulings: call-site key = AST ordinal (semantic layer rebuilds on producer change; renders alpha-only; checker key-independent); host-globals = curated data file pinned by test A10 + auto-surfaced host-global? candidates (>=3 fns); lazy ?-resolution REJECTED (breaks files-are-the-contract + P2.5; completeness not tradeable — renegotiate the budget number through this gate instead); stale reads solved by immutability (E4: re-decompile writes a NEW dir, --overwrite explicit).
- Real bug fixed (E1): overlayName was stored in render-independent functions.jsonl — layer violation vs A5 byte-identical-after-rename; now live-joined at query time.
- E2/E3/E5/E6/E7 applied in place; implementer note: step-6 checker's closure resolution must be an INDEPENDENT disasm-level def-use, never an import of the emitter's dataflow.
