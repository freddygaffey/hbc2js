# 2026-09-02 — --split boot fixes (loadable + prelude) — Sonnet, lean
Tokens 118k · tool calls 89 · green first try.

`--split` now emits a Metro `__d/__r` loader `index.js` (registers every `module_<id>.js` factory, installs the 8 `__hbc_*` helpers as globals, patches Module._load to route inter-module requires through __r, calls __r(entry)); modules end `__d(factory, id, deps)`. rn-template split tree: **0 → 76/435 modules execute** under bare Node (same jsdom-boundary stop as the spike). Gate test `tests/gate/split/loadable.test.ts` (no missing-symbol errors, ran ≥76). Tier-1 baseline unchanged (only the module epilogue line changed, never a body). Both stage-3 gaps → FIXED.
