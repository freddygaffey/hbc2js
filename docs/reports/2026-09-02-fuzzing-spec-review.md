# 2026-09-02 — fuzzing spec review gate (lean Fable) — APPROVED

45k tokens, 13 tool calls, ~4 min. Commit e4da11d. Decision-8 gate passed; construct-fuzzer impl (spec §7 steps 1-2) cleared to launch.

- Q1 divergence bar: ≤5/1,000 tolerance REJECTED → 0 novel divergences on the held-out eval range; every divergence needs a triaged signature (minimised fixture + BUGS.md row); ≤5 triaged-unfixed signatures/version at campaign close; rate kept only as volume tripwire. Also fixed §1.5.ii/§1.5.iv eval-range inconsistency.
- Q2 v98: obtainable for real (RN 0.86/0.87 → hermes-compiler 250829098.0.x emits HBC 98, class E/98-late only; 98-early stays fixture debt). Probe path fixed (hermes-compiler dep, not sdks/hermesc); direct-hermesc fallback specified.
- Q3 persistence: reports/fuzz/*.json gitignored (implementer adds reports/ to .gitignore); committed record = scoreboard row + B's manifest.
- Edits E1-E4 applied in-place; T1 8/8 post-edit.
