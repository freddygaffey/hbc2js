# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
1. **B — NSW screen resolution through Reflect.apply (product, HIGH)**: NSW invokes require + route components via `Reflect.apply(fn, this, [arg])`, one hop past `traceModuleOrigins` in src/split/segregate.ts, so 26 navigators are detected but 0 screens named. Add the Reflect.apply-form component resolution WITHOUT over-matching (the naive version regressed react-navigation-example 4→3 nav / 54→67 screens — see BUGS row 2026-09-02): gate it on the navigator call-shape + require-through-Reflect.apply specifically. Must NOT regress react-navigation-example (assert its 4 nav/54 screens/0.686 fuzzy hold) AND must produce NSW src/screens/ (HomeScreen, WalletTabScreen, LicenceLinkingStack... are in the strings). This is what makes NSW `segregate` (no deps) produce a real src/screens tree.
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.

- **[IN PROGRESS, launched 2026-09-02] Bulk sigdb round 2b — registry-driven candidates (lane B)**: `tools/pkgsig/bulk/candidates.mjs --registry` (registry search + downloads ranking + per-package version-history fetch, cached, resumable) + `continue-bulk.sh` (reused unchanged via `HBC2JS_BULK_ROUND_TAG=round2b`) chained by `tools/pkgsig/bulk/round2b-runner.sh`, running unattended on `deb` — first `--top 500` proof slice launched, not yet measured. Resume/status/widen commands + design: `docs/DEPS.md` "Round 2b". To resume after any interruption: `ssh -f deb 'setsid bash ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'`; to widen to the full top ~3000: same command with `HBC2JS_ROUND2B_TOP=3000` prefixed. Remaining: measure Service NSW/rn-template attribution once the first incremental assemble exists, record in DEPS.md, widen to 3000. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.

## Parked (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
- **Add clonable OSS apps (Expo examples) to the OSS ground-truth benchmark**: `tools/e2e/oss-benchmark.mjs`'s `APPS` array today has react-navigation-example-0.85.3 (scored, has a `.map`) and rn-template-0.72 (pipeline-only, no `.map`). Adding 2-3 more (an Expo example, a small react-navigation demo) needs cloning + building each with `npx expo export`/Metro to get a fresh bundle+map pair — network/build work `deb` would normally do, and `deb` is down as of 2026-09-02. Docs: docs/e2e/OSS-BENCHMARK.md "Adding an app".
