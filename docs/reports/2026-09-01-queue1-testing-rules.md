# 2026-09-01 — QUEUE 1: testing rules + enforcement — Sonnet, general-purpose + budget brief
Tokens 102k · tool calls 49 · landed green first try.

- `CLAUDE.md` "Testing rules" (CONSOLIDATION 7–10).
- `tests/gate/docs/testing-rules.test.ts`: rule 7 — flags whole-program golden literals asserted against shared-fixture decompiles in `tests/gate/passes/*.test.ts` (+ any .snap/.golden); rule 10 — every `KNOWN_*`/exclusion set entry in `src/harness/tiers.ts` must appear in BUGS.md. Zero current violations; misses documented.
- `tests/gate/docs/test-count.test.ts` + `docs/test-count-baseline.json` {"gate": 744}: count may only rise.
- First budgeted agent: ~3× cheaper than the pre-budget runs at the same quality.
