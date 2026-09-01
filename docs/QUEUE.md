# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.

- **[IN PROGRESS, launched 2026-09-02] Bulk sigdb round 2b — registry-driven candidates (lane B)**: `tools/pkgsig/bulk/candidates.mjs --registry` (registry search + downloads ranking + per-package version-history fetch, cached, resumable) + `continue-bulk.sh` (reused unchanged via `HBC2JS_BULK_ROUND_TAG=round2b`) chained by `tools/pkgsig/bulk/round2b-runner.sh`, running unattended on `deb` — first `--top 500` proof slice launched, not yet measured. Resume/status/widen commands + design: `docs/DEPS.md` "Round 2b". To resume after any interruption: `ssh -f deb 'setsid bash ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'`; to widen to the full top ~3000: same command with `HBC2JS_ROUND2B_TOP=3000` prefixed. Remaining: measure Service NSW/rn-template attribution once the first incremental assemble exists, record in DEPS.md, widen to 3000. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
- **B — Segregation MILESTONE 1 (product, `docs/specs/08-segregation.md` §5)**: `hbc2js segregate <split-dir>` (or `--segregate` on --split) that places each module into `node_modules/<pkg>/` (deps-attributed) vs `src/module_<id>.js` (app, per classify.ts), rewrites the __d/__r loader + require specifiers to the new paths, keeps MODULES.json. NO naming heuristics yet (module_<id>.js in src/). Prove: boot-split.mjs still reaches registerComponent on the segregated rn-template tree; byte-diff shows only paths/loader changed. Metric: % modules in node_modules vs src for rn-template + Service NSW. Then milestone 2 = naming.
- **C — default-params rung (F15 done; P-8 corrected shape)**: build match/rewrite/check/index against the REAL idiom `L0: { if (rX !== U) break L0; ...default...; break L0; }` (confirm at v94+v99 via `--emit-tree` on fixtures 51/39), NOT the spec's if/else. Decide if it belongs in default-params or a label-clean addendum. Sound recompute-and-diff checker (D14 polarity). Update spec 15 matcher description to match. 12→13 rungs.
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
17. A — CI app-metrics (finish origin/worktree-agent-a99810bd07c13c086).
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.

## Parked (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
