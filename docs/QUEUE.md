# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
1. **Cleanup a — testing rules (CONSOLIDATION 7–10):** rules into `CLAUDE.md`; gate test enforcing "no exact-output assertions on shared fixtures" (pattern `tests/gate/passes/imports.test.ts`); test-count-never-drops check.
2. **Cleanup b — STATUS.md to one screen (14):** scoreboard stages 1–5 (valid-JS %, round-trip-identical %, boots?, segregated %, readable %), milestones, gate numbers, open-bug count, blocked, decisions needed; narrative → AGENT-LOG.
3. **Cleanup c — sweep on every merge (20) + workflow rules (12, 16, 17)** into `docs/AGENT-WORKFLOW.md`.
4. **BUGS triage (d):** mark fixed rows; verdict for every open row (bug / D14-legit / duplicate); Status column open|fixed|wontfix; cluster.
5. **Fix: `--split` drops nested closures** — module files reference `_fnNNNN` declared in no split file (react-navigation: 688 fns → runtime ReferenceError; tier-1 bucket `tree:unmatched-closure`). Correctness, product path. `src/split/index.ts`.
6. **Fix cluster: deps (2 rows)** — `readLiterals` version at v≥97; nearest-release-by-date.
6. **Fix: generator `.obf` E_UNBOUND_IDENT** (23/26 at v94.obf with passes on).
7. **Fix: Service NSW whole-file abort** — scope-check isolation per function.
8. **Fix: Service NSW 452 s** — profile the 43k-function superlinear term.
10. **Fix cluster: semantics (6 adversarial rows)** — verdict first, fix the real ones.
11. **Tier-1 buckets:** make the normalised diff register/schedule-insensitive where the difference is provably allocation-only (top buckets `GetByVal(reg)`, `LoadParam(imm)`, `LoadConstUndefined/GetGlobalObject`), so IDENTICAL measures semantics not scheduling; re-baseline.
12. **Mutation-test the checkers (4)** — Stryker over `src/passes/*/check.ts`.
13. **Guards (27, 28).**

## Lanes (after cleanup; rotate A→B→C)
14. A — Stage-3 feasibility (31): `docs/e2e/STAGE3-FEASIBILITY.md` + 30-min RN-web boot spike on rn-template.
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
16. C — default-params (spec 15).
17. A — CI app-metrics (finish origin/worktree-agent-a99810bd07c13c086).
18. B — Segregation spec (D17i stage 3: name modules, detect screens/navigators/stores, emit `src/` + `node_modules/`).
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.

## Parked (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
