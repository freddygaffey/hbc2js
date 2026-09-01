# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
6. **Bulk signature DB, round 2 on `deb` (Fred, 2026-09-01)** — Sonnet. Goal: 100% module attribution on Service NSW and the repo bundles. (a) On the Mac: `hbc2js deps --json` on Service NSW (background, ≤30 min) + react-navigation + expensify truth files → a candidate list of package NAMES + version ranges (from hint-tier strings, `node_modules` path evidence, unattributed-module strings, plus RN 0.73–0.76 and the RN-ecosystem top-300); the corpus and bundles may be copied to `deb` (Fred: same privilege as the Mac) — so run the Service NSW `deps` and re-checks on `deb` itself, 32 cores; just never commit corpus content to the repo. (b) On `deb` (ssh host `deb`, existing pipeline ~/hbc2js-bulk, tools/pkgsig/bulk/build-one.mjs, node 22 via fnm): a `continue-bulk.sh` that consumes the list, skips already-fingerprinted (name, version) pairs, runs under nohup with N parallel jobs, assembles incrementally (tools/pkgsig assemble), logs progress to a file; document restart/resume. (c) When a chunk assembles: refetch on the Mac, re-run `deps` on NSW, report attribution % before → after; publish as a new GitHub release asset only when Fred says. Precedent: docs/DEPS.md bulk section, sigdb-20260830 (32,708 sigs, RN 0.73.x absent).
7. **Fix: `--split` drops nested closures** — module files reference `_fnNNNN` declared in no split file (react-navigation: 688 fns → runtime ReferenceError; tier-1 bucket `tree:unmatched-closure`). Correctness, product path. `src/split/index.ts`.
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
