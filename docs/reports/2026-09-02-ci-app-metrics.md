# 2026-09-02 — CI app decompile metrics — Sonnet, lean

Tokens ~85k · tool calls ~37 · green.

Rebuilt `tools/app-metrics.mjs` from `origin/worktree-agent-a99810bd07c13c086`'s
unrun content (fetched, never merged). Verified it end to end against today's
`decompile()`/`splitProject()`/`runDeps()` APIs — it needed **no logic
changes**, only a repo-relative `bundle` display path (so the committed
baseline doesn't bake in a worktree path). The pass-pipeline slowness noted in
PUSHBACK P-1 (rn-template whole-file, passes on, >180 s) had already been
fixed by the time this ran: whole-file decompile with all M5 passes + `node
--check` now takes ~3.3 s, so CI can afford whole-file rather than falling
back to `--split` timing.

rn-template-0.72 table (`node tools/app-metrics.mjs --split`):

| metric | value |
| --- | --- |
| decompile | OK (~3.3 s) |
| total functions | 4199 |
| stubbed (isolation) | 0 (0.0%) |
| unresolved-env markers | 0 |
| output bytes | 4,752,291 |
| output lines | 174,458 |
| node --check | OK |
| `rN` registers / 1k lines | 201661 (1155.93) |
| `Reflect.apply(` / 1k lines | 4353 (24.95) |
| `_fnN` names / 1k lines | 4714 (27.02) |
| `__hbc_` helper calls / 1k lines | 531 (3.04) |
| split: modules | 435 |
| split: library / custom / unknown modules | 308 / 72 / 55 |
| split: % library by weight | 41.1% |
| split: % custom by weight | 53.2% |

Round-trip/tier-1 "% IDENTICAL" was skipped, not folded in: it needs a
matching `hermesc` recompile and this worktree had no cached `tools/hermesc`
— not cheap per the brief's own "if it's a quick call — else skip" clause.
Noted in docs/TESTING.md's new section; `tools/e2e/` already owns that ratchet.

Delivered:
- `tools/app-metrics.mjs` (finalised, repo-relative bundle path) + `tools/app-metrics.d.mts` (typed import for the `.ts` test, matching `passes-metrics.d.mts`'s convention).
- `tests/gate/tools/app-metrics.test.ts`: structural regression (decompile ok, nonzero functions, `node --check` ok, split attached) — not a metric-value assertion, per docs/CONSOLIDATION.md §B item 7.
- `.github/workflows/ci.yml`'s new `app-metrics` job: ubuntu, own checkout/setup/`npm ci` (no hermesc needed — `decompile()` doesn't call it), runs `--split --json` to an artifact and `--split` markdown to `$GITHUB_STEP_SUMMARY`; fails only if the tool crashes (script's own SCOPE GUARD), never on a metric value; ~5 min timeout, actual run ~5-10 s of work plus checkout/install.
- `docs/metrics/app-metrics-baseline.json` (committed, `--split --json` output).
- docs/TESTING.md "App metrics" section (columns, how to run, why round-trip is excluded).
- docs/QUEUE.md: popped item 17.

Gate: `npm test` — 1353 tests, 1336 pass, 0 fail, 17 skipped, ~110 s (typecheck green).
