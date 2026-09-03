# 2026-09-04 — lazyRequire screen detection fix (lean Sonnet)

168k tokens (over budget; diagnosis-heavy — acceptable given two approaches tried+reverted), 114 calls, ~21 min. Commit eb8f3ca.

- Root cause: Hermes INLINES the thin loader (no function survives); require+interop+env-slot write lands textually AFTER the JSX closure reading the slot; traceModuleOrigins' single left-to-right scan never connects them.
- Fix: order-independent env-slot origin resolution (bounded statement-run regex) feeding jsxScreenPending ONLY with statement adjacency; §3.1 navigator+component gate unchanged. Two broader variants tried and REVERTED (pin regressions / 2 false screens from barrels) — documented in BUGS.
- Verified 3 ways: appgen triple 0/4 -> 4/4; corpus sweep green (no new false screens); react-navigation pins byte-identical. +2 regression tests (positive + the reverted approach's own false-positive as a negative).
- Gate 1926/1926.
