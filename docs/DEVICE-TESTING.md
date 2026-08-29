# Device testing (D16a)

**What this proves.** Everything else in this repo checks the decompiler
against oracles running in a sandbox (`docs/DECISIONS.md` D2/D3): Node's
`vm`, a source-built Hermes VM, `hermesc` recompilation. None of that proves
the decompiled output actually runs inside a real React Native app on a
real Android device under the production Hermes engine, with the app's own
JSI/TurboModule/Fabric glue live underneath it. D16a is that proof, on our
own throwaway app, done once so the pipeline is on record and repeatable.

**Result on record (2026-08-30, tablet `HA2APYTS`, RN 0.72.17, HBC 94):**
decompiled-JS variant and hermesc-recompiled-HBC variant both installed,
launched, and ran with **byte-identical `ReactNativeJS` logcat output** and
**0.0000% RMSE screenshot diff** (both the full screenshot and the
status-bar-excluded content region) against the original build, across a
3-tap interaction sequence exercising state, a rendered loop, a generator,
an async function, and try/catch/finally.

## What "identical" means here

- **Logcat**: `adb logcat -s ReactNativeJS:*` captured for both runs, then
  each line's `MM-DD HH:MM:SS.mmm PID TID I ReactNativeJS: ` prefix is
  stripped (timestamps and process/thread ids necessarily differ between
  two separate app launches) before a plain `diff`. What's left is the
  literal `console.log` message text emitted by the running JS —
  `RT:mount`, `RT:list:...`, `RT:tap:count=N`, etc. Byte-identical after
  that normalization is the bar; anything else is DIVERGENT.
- **Screenshots**: `adb exec-out screencap -p`, compared with ImageMagick
  `compare -metric RMSE`. Reported twice: over the full screenshot, and
  over the same image with its top 3% cropped off (comfortably taller than
  the status bar on every device tried) — the status bar's clock digits are
  the one part of the screen this test *expects* to legitimately differ
  between two runs taken a few seconds apart, so the content-region number
  is the one that actually matters. RMSE is reported as a percentage (0%
  = pixel-identical); it isn't a byte count, so a single differing pixel
  channel already moves it off 0, which is why the observed values below
  are numerically tiny rather than exactly 0 whenever timing shifts the
  clock into frame.

## The test app

`tools/device-roundtrip.sh` scaffolds (or, with `--app`, reuses) a
`react-native@0.72.17` app — matching the bytecode version this repo's
`tools/hermesc/v94/` targets (see `tests/fixtures/bundles/rn-template-0.72/
BUILD.md`) — and overwrites its `App.tsx` with a small screen that, on
mount and on each tap, exercises exactly the constructs D16a needs to
distinguish a shallow "it doesn't crash" result from a real behavioral
match:

- a counter (`useState` + a button `onPress` handler, tapped 3 times per
  run) — proves closures/event handling round-trip;
- a list built by a `for` loop and rendered (`items.map`) — proves loop +
  array construction;
- a generator (`function*` computing Fibonacci numbers) consumed by a
  `for...of` — proves generator lowering under real Hermes, not just the
  sandboxed oracles;
- an `async function` that `await`s two `setTimeout`-based microtask hops —
  proves async/await lowering with genuine event-loop yields, not a
  synchronously-resolving stand-in;
- a `try`/`catch`/`finally` — proves exception-region lowering.

Every step logs a `console.log('RT:...')` marker, which is what the logcat
comparison actually diffs.

## Running it

```sh
tools/device-roundtrip.sh [--app <dir>] [--variant js|hbc] [--keep]
```

- No device attached → exits 3 immediately (the sweep test in
  `tests/sweep/device/roundtrip.test.ts` treats this as INCONCLUSIVE, not a
  failure — true on almost every dev machine and all CI runners).
- `--app <dir>`: point at an already-`npm install`-ed RN 0.72.17 app
  directory to skip the ~30s scaffold + install step while iterating on the
  script itself. Its `App.tsx` is always overwritten with the known-good
  test screen above, regardless of what was there.
- `--variant js` (default): the decompiled JS is dropped straight into the
  APK's `assets/index.android.bundle` — Hermes compiles plain JS at load
  time, no recompile step needed.
- `--variant hbc`: additionally recompiles the decompiled JS back to
  Hermes bytecode with `tools/hermesc/v<N>/hermesc -O` (N read from the
  extracted bundle's own header via `file`) and tests *that* repackaged
  APK instead. Only works when a matching `tools/hermesc/v<N>/` build
  exists (today: v94, i.e. the default RN-0.72.17 app this script
  scaffolds — pointing `--app` at a different RN version's bundle without
  a matching hermesc build fails fast with a clear message rather than
  silently falling back to `js`).
- `--keep`: skip the final `adb uninstall` (for manual poking after a run).

Exit codes: `0` PASS, `1` an environment/build/install problem (see
stderr — the script tails the relevant log and stops rather than guessing
at a fix, per the project's token-hygiene rule), `2` DIVERGENT (logcat or
screenshot genuinely differs — a real bug, always worth a fixture), `3` no
device attached.

Everything the script builds (the scaffolded app, the extracted bundle, the
decompiled JS, the repackaged APKs) lives under a `mktemp -d`, well outside
this repo, per the project's "all app builds happen in scratch" rule; only
`tools/device-roundtrip.sh`, `tools/device/lib.sh`, and this doc are
committed.

## Prerequisites

- **`adb`** (Android SDK platform-tools) with exactly one device in
  `adb devices`'s `device` state. If more than one is attached, `export
  ANDROID_SERIAL=<serial>` first.
- **A JDK 17.** The RN 0.72 template's Gradle wrapper (8.0.1) cannot run
  under JDK 21+; `tools/device/lib.sh`'s `dr_pick_java17` looks for
  Homebrew's user-space `openjdk@17` keg first (`brew install openjdk@17` —
  note: **not** the `--cask temurin@17` this task was originally pointed
  at, which runs a `pkg` installer requiring `sudo`/a password prompt this
  agent cannot supply; the plain Homebrew *formula* installs into the
  Cellar with no privilege escalation and works identically for this
  purpose), then falls back to `/usr/libexec/java_home -v 17` on macOS.
- **Android SDK build-tools** with `zipalign` and `apksigner`, and a debug
  keystore at `~/.android/debug.keystore` (generated automatically by any
  prior Android build on the machine). The script picks the
  highest-versioned `build-tools/*` directory it finds; nothing else about
  the specific version matters for this task.
- **ImageMagick** (`compare`, `identify`, `magick`) for the screenshot
  diff — optional; its absence degrades the report to "SKIPPED" for that
  line rather than failing the run.
- Network access for the one-time `npx react-native@0.72.17 init` +
  `npm install` (skipped entirely when `--app` points at an
  already-installed app).

## Known device quirks (read this before assuming a failure is a bug)

- **`INSTALL_FAILED_VERIFICATION_FAILURE` on the first `adb install` of a
  given APK.** Seen repeatedly on the tablet this was developed against;
  a bare retry (same command, `--no-streaming`) succeeds roughly half the
  time with zero human involvement — `tools/device/lib.sh`'s
  `dr_install_retry` already retries up to 5 times with a short backoff
  before giving up. This looks like the device's own install-time
  verifier racing the push, not anything specific to a sideloaded or
  modified APK.
- **"Google Play Protect: unsafe app blocked" — needs a manual tap +
  device password.** Distinct from the above: on a device where Play
  Protect flags a debug-signed sideloaded APK, Android shows a genuine
  on-device dialog that only a human can dismiss (it needs the device's
  own lock-screen credential, which `adb` has no way to supply and this
  task's brief does not authorize working around by changing device
  settings). If `dr_install_retry` exhausts its retries, this is the first
  thing to check on the device screen; dismiss it once and re-run. It did
  **not** reappear on every install in practice — once seen and cleared it
  went quiet for the rest of a session, but came back after a device
  reboot. Turning off Play Protect scanning entirely (Play Store → profile
  icon → Play Protect → gear icon) or `adb shell settings put global
  verifier_verify_adb_installs 0` removes it for good, but both are device
  security-posture changes this task deliberately leaves to whoever owns
  the device, not something the script does for you.
- **Tap coordinates are resolved live, not hardcoded.** `dr_element_center`
  (`tools/device/lib.sh`) runs `adb shell uiautomator dump` and parses the
  `bounds="[x1,y1][x2,y2]"` of the `counter-button` `testID` (React
  Native's Android renderer exposes `testID` as the view's
  `resource-id`), so the interaction sequence isn't tied to one device's
  screen resolution. Its regex has one documented sharp edge worth knowing
  if you're editing it: the first `grep -o`'s `[^/]*` is a greedy POSIX ERE
  quantifier (no lazy quantifier exists in this dialect) and can span past
  the target node's own `bounds=` into a later node's before backtracking
  — the fix already applied is to take the *first* `[x1,y1][x2,y2]`
  substring out of whatever span it captured (`head -1` again after the
  second `grep -o`), since node order in the dump is preserved regardless
  of how far the first match overshot.

## Regenerating this result

```sh
tools/device-roundtrip.sh                 # variant js, fresh scaffold
tools/device-roundtrip.sh --variant hbc   # hermesc-precompiled variant
```

Both were run to completion against the tablet on 2026-08-30 with a
reused, already-`npm install`-ed scaffold (`--app`) after the fresh-scaffold
path was exercised once manually; both reported `logcat: IDENTICAL` and
`0.0000%` on both the full and content-region screenshot diff.
