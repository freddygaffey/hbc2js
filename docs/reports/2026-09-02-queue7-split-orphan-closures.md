# 2026-09-02 — QUEUE 7: --split drops nested closures — Sonnet, lean
Tokens 146k · tool calls 116 · green first try.

Root cause: functions with no creation site in the closure-env analysis ("orphans") are fine in the single-file path but `--split` never wrote them, while modules still called them by name → ReferenceError. Fix: scan each module's printed factory for undeclared `_fnN`, pull the decompiled body in nested inside the factory, transitively. react-navigation dangling refs 2188 → 0; tier-1 `tree:unmatched-closure` 2921 → 1358 (residual = env-graph placement, new BUGS row); IDENTICAL 25.3→28.7% off / 29.5→32.9% on; baseline bumped. Gate test (rn-template) + sweep test (react-navigation). P-7 (shared orphans: first module wins) accepted; `_shared.js` goes to the segregation spec.
