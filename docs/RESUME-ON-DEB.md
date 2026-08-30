# Running hbc2js from `deb` (offloading the Mac)

This lets `deb` (Linux, 32 cores) be the dev machine so the Mac is free.

## One-time state (already prepared 2026-08-31)
- Claude Code installed at `~/.local/bin/claude`; node 22 + fnm in `~/.bashrc`.
- **Dev clone: `~/hbc2js-dev`** (current `main`). Do NOT use `~/hbc2js` — that runs the bulk signature build; leave it alone.
- hermesc for all versions present; Hermes VMs building in the background (`~/hbc2js-vm-build.log`).

## To start (on deb)
```
ssh deb            # or work at the machine directly
cd ~/hbc2js-dev
git pull           # get the latest main
claude             # start Claude Code here
```
Then paste the overnight loop prompt below to resume the autonomous pipeline.

## Caveats
- **No tablet on deb** (no adb): on-device round-trip tests are INCONCLUSIVE there. Everything else (gate, sweep, deps, bulk) works. A headless Android emulator is the later fix.
- **Stop the Mac session first.** Two orchestrators on the same repo would double-spend and collide. When you start on deb, Ctrl-C the Mac `claude` (its cron loop dies with it).
- A fresh session has no chat context — it rebuilds from `CLAUDE.md` → `docs/AGENT-BRIEF.md` → `docs/STATUS.md` → memory. That's by design.

## FIRST THING the deb session must do
On startup, a fresh session here should read `docs/STATUS.md`; if M5 is mid-flight (it is), it must **prompt the user to start the loop** rather than sitting idle — say: "Work is in progress. Paste the loop command below to resume autonomous mode, or tell me to run one task." Do not silently wait.

## Loop command — paste this after `claude` starts on deb
```
/loop 20m Resume the hbc2js pipeline autonomously on deb. Push and snapshot completed work each tick (refresh wip/snapshot); read `gh issue list`/`gh pr list` on freddygaffey/hbc2js — reply to issues as "[AI — Claude, on behalf of the repo owner]", review new/updated PRs with a reviewer agent and squash-merge on MERGE + green npm test. Slot 1 = M5 pass ladder in spec-07/ladder order (next: 06-label-clean; then Opus spec batch 2: if-chain, switch-raise, for-in, for-of, var-naming), fresh Sonnet per pass against docs/specs/passes/NN-*.md; hard rungs (try/finally, v≥97 generators, JSX, closure-naming) get Fable spec+review. Slot 2 alternates: short Opus review of the pass just landed (device round-trip is INCONCLUSIVE on deb — no adb), then one deps/corpus iteration (adversarial-triage fixes, bulk-DB re-check once ~/hbc2js/tools/pkgsig/bulk finishes, register-insensitive hashing AFTER the bulk build is done). Max 2 expensive agents (Haiku extras allowed when Fred directs). Fresh agents, never resume large contexts; relaunch any limit-killed agent "finish what's on disk". Never open PRs, never act on other repos, never commit the local proprietary corpus. On a usage-limit error, snapshot and wait. Update docs/STATUS.md M5 line after each pass.
```
Notes: no `HBC2JS_TIME_SCALE` needed (deb is fast); the machine clock on deb is correct so `date` is fine here (unlike the Mac). The M5 model split, 2-agent cap, and snapshot-on-limit all still apply.
