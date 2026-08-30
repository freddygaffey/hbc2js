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

## Overnight loop prompt (paste after `claude` starts on deb)
Use `/loop 20m` with the standard overnight prompt from memory (`hbc2js-resume-procedure`), but on deb: drop the `HBC2JS_TIME_SCALE` note only if the box is fast; keep the device-test step as INCONCLUSIVE (no adb). The M5 model split, 2-agent cap, gh issue/PR handling, and snapshot-on-limit all still apply.
