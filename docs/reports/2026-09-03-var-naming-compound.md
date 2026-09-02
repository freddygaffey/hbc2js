# 2026-09-03 — var-naming compound (lean Sonnet) — LAST DEFAULT LADDER ITEM

165k tokens (outlier #4), 117 tool calls, ~22 min. Commit a480a4c.

- 8 new evidence-ranked heuristics (container-subscript->list, property-read alias->property name, alias-of-named, obj/fn literals, flag, limit, widened arr methods, numeric accumulator->sum), all refuse-on-ambiguity; pure alpha-renaming through existing machinery.
- registers-named: rn-template BUNDLE 4.1% -> 20.2% (TARGET >=15% PASSED); construct gate 3.4% -> 13.1% (short of 15, honest); full matrix 3.1% -> 10.0%.
- Q1 second expr-rebuild: CLOSED under D23 (structure rung may not run after a renaming rung) — documented in spec 19 §9.
- 2 name-shape regexes in other rungs' tests widened to structural form (improvement pinning, not inversion). pipeline-speed flaked under load, re-ran standalone 7.4s — contention noise.
- Gate at landing: passes scope 1761/1764, 0 fail; full typecheck blocked only by the concurrent P2.1 agent's WIP (expected).
