# Corpus-wide regression sweep

Fred's ask (2026-09-02): "run much more end-to-end testing on almost all the
binaries we have saved, checking changes aren't making anything else worse."
`tools/e2e/corpus-regression.mjs` runs the pipeline — decompile → `--split` →
`segregate` (no `deps`, for speed: segregate falls back to call/config shape
alone for naming) — over the **whole proprietary local corpus**
(`~/hbc2js-local-corpus/apks/*.apk`, 28 real apps, never committed) and scores
each app on its own, with no ground truth.

This exists because a one-off sweep caught a real **local maximum**: a
screen-naming heuristic tuned to look great on `au.gov.nsw.service` produced
garbage screen names (SVG/CSS/library tokens, `ALL_CAPS` constants) on
`com.brex.mobile` and `com.uniswap.mobile` — a plausible-looking win on the
one app being iterated on, a silent regression everywhere else. Unlike
`tools/e2e/oss-benchmark.mjs` (one app, scored against a real source map),
this tool trades ground truth for breadth: no precision/recall, just
per-app metrics plus **overfit / local-maximum detectors** — heuristics that
flag suspicious output without knowing the real answer.

## Run it

```sh
# One app, locally (fine for a small bundle):
node tools/e2e/corpus-regression.mjs --only au.gov.nsw.service --json

# Several apps, table output:
node tools/e2e/corpus-regression.mjs --only au.gov.nsw.service,com.brex.mobile,com.uniswap.mobile

# The whole configured corpus, offloaded to deb (see "Running on deb" below):
node tools/e2e/corpus-regression.mjs --on-deb --json --out /tmp/corpus-sweep.json

# A different corpus location:
node tools/e2e/corpus-regression.mjs --corpus-dir /path/to/apks
# or: HBC2JS_CORPUS_DIR=/path/to/apks node tools/e2e/corpus-regression.mjs
```

`--only app1,app2` restricts to a subset (comma-separated app ids — an app id
is the APK's filename without `.apk`). `--json` prints the full sweep object
instead of the summary table; `--out FILE` also writes it to a file
(`docs/e2e/corpus-baseline.json` when updating the baseline, below). With no
corpus present at all, every app reports `"decompile": {"status": "no_apk"}`
— this is the state `npm test` runs in (no APK on the CI box), and it is a
skip, not a failure.

**Memory:** decompiling needs roughly 300x the input bundle size in heap
(see `hbc2js --help`'s Memory note). The biggest bundles in this corpus are
tens of MB, so run with `NODE_OPTIONS=--max-old-space-size=8000` or higher
locally; deb has more headroom.

## Running on deb (heavy decompiles — don't thrash the Mac)

`--on-deb` extracts each app's bundle **locally** (cheap: `unzip`, not a
decompile), `scp`s just that one bundle to deb, runs this same script's
single-bundle mode (`--bundle-file <path> --app <name>`) there over `ssh`,
reads the JSON back, and cleans up both ends. The whole APK is never sent —
only the already-extracted bundle, and only for the app currently being
measured (nothing pooled on deb). deb's `~/hbc2js` checkout needs this
script (it isn't committed to `main` until this task lands there) — sync it
once per session:

```sh
ssh deb 'cd ~/hbc2js && git pull --ff-only -q'
scp tools/e2e/corpus-regression.mjs deb:~/hbc2js/tools/e2e/corpus-regression.mjs
```

deb runs node 22 via fnm — `export PATH="$HOME/.local/share/fnm:$PATH"; fnm
exec --using 22 -- <cmd>` (this script builds that command itself for
`--on-deb`, nothing extra to do). deb's disk fills fast (was ~96% full when
this was written): each app's scp'd bundle and the remote tmp dir it lands
in are removed as soon as that app's measurement returns, win or lose.

## Extraction: bundle location

Bundles are extracted straight from the APK zip with `unzip -o -q -j
<apk> <entry> -d <dir>`. The conventional entry is
`assets/index.android.bundle`; some apps ship it elsewhere (observed:
`au.gov.vic.myvicroads` has **no** React Native bundle in its APK at all —
it isn't actually a Hermes/RN app, or ships it in a split APK this tool
doesn't fetch). The extractor tries, in order: `assets/index.android.bundle`,
`assets/index.bundle`, `assets/app.bundle`, `assets/main.jsbundle`, then any
`assets/**/*.{bundle,hbc}`-looking zip entry. No match → that app's status is
`"no_bundle_found"` and the sweep moves on; it never aborts the run.

## Per-app metrics

| field | meaning |
| --- | --- |
| `decompile.status` | `ok`, `crash` (with `errorCode`/`errorMessage`), `no_apk` (not in the corpus dir), or `no_bundle_found` |
| `totalModules` | module count from `--split` |
| `validJsPct` | % of split modules that parse as valid JS (in-process `vm.Script` parse check — the `node --check` equivalent, run in-process because a corpus app can have thousands of modules and a subprocess per file would dominate wall time) |
| `stubbedDiagnostics` | count of `splitProject`'s own diagnostics (e.g. a module whose scope check failed after every function was still emitted — docs/BUGS.md 2026-09-01, `E_UNBOUND_IDENT`) |
| `split.{src,node_modules,unclassified}` | module counts per segregation bucket |
| `screens.detected` / `screens.plausible` / `screens.plausibilityRatio` | see below |
| `navigators.detected` | modules landing in `src/navigation/` |
| `varNaming.pct` | proxy for "% of registers a naming pass gave a real name to": of every `var`/`let`/`const` declaration in the `src/`-bucket text, the fraction whose declared name is NOT a raw `rN` register name. Same textual-proxy convention as `tools/app-metrics.mjs`'s readability numbers — not an AST walk. |
| `readability.{registers,reflectApply,anonFnNames}` | `rN` / `Reflect.apply(` / `_fnN` occurrences per 1k lines (same convention as `tools/app-metrics.mjs`) |
| `overfitFlags` | this app's detector hits (below) — `[]` when clean |

## Overfit / local-maximum detectors

No ground truth exists for this corpus, so these are **heuristics that flag
suspicious output**, not proof of a bug — read a flag as "worth a human
look," not "confirmed wrong." `screens.plausibilityRatio` is the headline
number (`isPlausibleScreenName`, exported from the tool so a test or another
script can reuse the exact rule a baseline was scored with): a segregated
`src/screens/<Name>.js` module's `<Name>` is implausible if it's a single
letter, an `ALL_CAPS_CONST`, contains `__closure`, or is a common
library/CSS/SVG/RN-primitive token (`View`, `Path`, `G`, `StyleSheet`,
`Animated`, …) — exactly the class of false positive the NSW → Brex/Uniswap
sweep caught. A `module_<id>` fallback name (no naming signal fired at all)
is **not** flagged — an unnamed screen isn't evidence of a wrong name, just
an absent one.

Per-app flags (`overfitFlags`, each a plain string):

- **decompile crash** — `decompile.status === "crash"`.
- **0% valid-JS modules** — every split module failed to parse.
- **screens with no navigator evidence** — `screens.detected > 0` and
  `navigators.detected === 0` in the same app: a screen detector firing with
  nothing that looks like a route table backing it up.
- **low screen plausibility** — `screens.detected >= 3` (small samples are
  noisy) and `screens.plausibilityRatio < 0.5`.
- **var-naming % far below the corpus median** — more than 20 points below
  the sweep's own median `varNaming.pct` (apps with ≤ 50 total declarations
  are excluded — too small a sample).

## The baseline and the sweep-tier test

`docs/e2e/corpus-baseline.json` is a captured sweep (`--json --out`) checked
into the repo — metrics and generic tokens only, **never** bundle/module
content (screen `sample` names are the only per-module strings it stores,
and those are Fred-approved-corpus-public route labels like `"Home"` /
`"Login"`, not source text). `tests/sweep/e2e/corpus-regression.test.ts`
re-runs the sweep for whichever baseline apps have a local bundle available
(same graceful-skip pattern as `tests/sweep/e2e/oss-benchmark.test.ts` — a
missing corpus is not a failure) and compares:

- **Hard-fail (correctness regression):** an app that baselined `ok` now
  reports `crash`; `validJsPct` drops from the baseline; `screens
  .plausibilityRatio` drops from the baseline (a change adding
  false-positive screen names, the exact NSW → Brex/Uniswap failure mode).
- **Report-only (pure metric drift):** every other field — module counts,
  `varNaming.pct`, readability proxies — is logged via `t.diagnostic`, never
  asserted, since this baseline's job is to surface real numbers, not freeze
  every one (same rule `oss-benchmark.test.ts` documents).

Run it with the sweep tier: `HBC2JS_TIER=sweep npm run test:all`, or
directly: `node --test tests/sweep/e2e/corpus-regression.test.ts` (still
needs `HBC2JS_TIER=sweep` — the file calls `requireSweep(t)` first).

## Updating the baseline

**Needs Fred's approval, reviewed as a batch** — same rule as any
golden/snapshot regeneration (`CLAUDE.md` testing rules). Never regenerate
it inside an implementation task. To propose an update:

```sh
node tools/e2e/corpus-regression.mjs --on-deb --json --out docs/e2e/corpus-baseline.json
```

Every number in the new baseline must be **≥** the number it replaces for
the hard-fail fields above (`validJsPct`, `screens.plausibilityRatio`, no app
that was `ok` becoming `crash`) — a baseline update that lowers one of those
is exactly the regression this harness exists to catch, not a routine
refresh. Queue it for Fred; don't land it inside an unrelated change.

## Coverage note

The full corpus is 28 apps; a baseline captured under a tight token/tool-call
budget may cover fewer (the harness is resumable — `--only` a missing subset
and merge the results, or re-run `--on-deb` for the whole `CORPUS_APPS`
list once budget allows). `docs/e2e/corpus-baseline.json`'s own `apps` array
is the source of truth for exactly which apps it covers as of its capture
date.
