# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
- **C — spread-rest rung (spec 17, after:destructure) then optional-chain (18)**: implement per spec, sound checker, RUNG-OWNED assertions. src/passes/.
1. **B — More route RESOLUTION (unblocks both screens AND navigator names)**: 23/26 NSW navigators stay generic and many screens stay unresolved because their route entries use shapes the walk does not yet trace — the tracked gaps (BUGS 2026-09-02): (a) a route whose depmap index is 2 statements `r=N; r=arr[r]` not one literal bracket; (b) route-config shapes other than the factory/`.entries` one already handled. Extend traceModuleOrigins / the route-config walk to these, GATED (no react-navigation-example regression: 4/54 deps, 6/58 no-deps assert.equal), with committed fixtures. Each newly-resolved route set cascades to a screen file AND a navigator name. Target: NSW route-named navigators up from 3/26, screens up from 36.
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.

- **[IN PROGRESS, launched 2026-09-02] Bulk sigdb round 2b — registry-driven candidates (lane B)**: `tools/pkgsig/bulk/candidates.mjs --registry` (registry search + downloads ranking + per-package version-history fetch, cached, resumable) + `continue-bulk.sh` (reused unchanged via `HBC2JS_BULK_ROUND_TAG=round2b`) chained by `tools/pkgsig/bulk/round2b-runner.sh`, running unattended on `deb` — first `--top 500` proof slice launched, not yet measured. Resume/status/widen commands + design: `docs/DEPS.md` "Round 2b". To resume after any interruption: `ssh -f deb 'setsid bash ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'`; to widen to the full top ~3000: same command with `HBC2JS_ROUND2B_TOP=3000` prefixed. Remaining: measure Service NSW/rn-template attribution once the first incremental assemble exists, record in DEPS.md, widen to 3000. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
- **C — Implement batch-3 rungs (specs now exist)**: implement destructure (spec 16), then spread-rest (17, after:destructure), then optional-chain (18) — one lean Sonnet agent each, sound recompute-and-diff checker per spec, RUNG-OWNED test assertions, full gate green. 13→16 rungs.
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.

## Parked (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
- **Add clonable OSS apps (Expo examples) to the OSS ground-truth benchmark**: `tools/e2e/oss-benchmark.mjs`'s `APPS` array today has react-navigation-example-0.85.3 (scored, has a `.map`) and rn-template-0.72 (pipeline-only, no `.map`). Adding 2-3 more (an Expo example, a small react-navigation demo) needs cloning + building each with `npx expo export`/Metro to get a fresh bundle+map pair — network/build work `deb` would normally do, and `deb` is down as of 2026-09-02. Docs: docs/e2e/OSS-BENCHMARK.md "Adding an app".
