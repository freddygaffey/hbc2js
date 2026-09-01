# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
1. A — Stage-3 feasibility (31): `docs/e2e/STAGE3-FEASIBILITY.md` + 30-min RN-web boot spike on rn-template.
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.
12. **Mutation-test the checkers (4)** — Stryker over `src/passes/*/check.ts`.
13. **Guards (27, 28).**

- **Bulk sigdb round 2b — registry-driven candidates (lane B)**: deb has network. Build the candidate list FROM npm: `registry.npmjs.org/-/v1/search?text=keywords:react-native&size=250&from=N` paginated (+ `keywords:expo`, `react-native-*` name search), rank by `api.npmjs.org/downloads/point/last-month/<name>` (batch endpoint), take the top ~3,000 packages × every version published in the last 24 months (each package's registry doc `time` field), minus already-fingerprinted pairs → tens of thousands of jobs; run `continue-bulk.sh` for days on deb (12–24 parallel, disk cleanup per package, incremental assemble every 500). Re-measure Service NSW / rn-template / react-navigation attribution after each assemble; report in DEPS.md. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
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
