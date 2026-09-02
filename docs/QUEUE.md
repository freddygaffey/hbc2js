# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
1. **B — Segregation MILESTONE 3 — NAMING (TOP PRIORITY, Fred 2026-09-02: naming > register soup) (spec 08 §3)**: name app modules from screens/navigators/stores. Fixture `tests/fixtures/bundles/react-navigation-example-0.85.3/` is PRESENT locally (index.android.hbc + .bundle + .map source-map ground truth) — NO fetch/deb needed. Detect navigators (`create<X>Navigator` via deps → @react-navigation), walk each navigator's route-config object/JSX for `{name, component}` pairs → resolve the component module via require edges → `src/screens/<Name>Screen.js`; `createSlice`/`createStore` → `src/store/<name>Slice.js`; components (jsx-recover output, capitalised export) → `src/components/<Name>.js`. Extend src/split/segregate.ts. Metric: % src modules named + screens/navigators/stores detected on react-navigation-example (this is where the number moves from ~1% up). Boot-still-works + byte-diff bodies unchanged. The .map is ground truth to VALIDATE names against — report name-accuracy vs the map.
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.

- **[IN PROGRESS, launched 2026-09-02] Bulk sigdb round 2b — registry-driven candidates (lane B)**: `tools/pkgsig/bulk/candidates.mjs --registry` (registry search + downloads ranking + per-package version-history fetch, cached, resumable) + `continue-bulk.sh` (reused unchanged via `HBC2JS_BULK_ROUND_TAG=round2b`) chained by `tools/pkgsig/bulk/round2b-runner.sh`, running unattended on `deb` — first `--top 500` proof slice launched, not yet measured. Resume/status/widen commands + design: `docs/DEPS.md` "Round 2b". To resume after any interruption: `ssh -f deb 'setsid bash ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'`; to widen to the full top ~3000: same command with `HBC2JS_ROUND2B_TOP=3000` prefixed. Remaining: measure Service NSW/rn-template attribution once the first incremental assemble exists, record in DEPS.md, widen to 3000. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
- **C — default-params rung (F15 done; P-8 corrected shape)**: build match/rewrite/check/index against the REAL idiom `L0: { if (rX !== U) break L0; ...default...; break L0; }` (confirm at v94+v99 via `--emit-tree` on fixtures 51/39), NOT the spec's if/else. Decide if it belongs in default-params or a label-clean addendum. Sound recompute-and-diff checker (D14 polarity). Update spec 15 matcher description to match. 12→13 rungs.
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.

## Parked (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
