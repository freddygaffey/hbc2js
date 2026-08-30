# `hbc2js deps` — npm dependency extraction

Implements D17/D17a/D17b (`docs/DECISIONS.md`). Identifies which npm
packages are inside a compiled Metro/Hermes bundle (or an `.apk` containing
one), using bytecode fingerprinting first and evidence-scored guessing
second — never by executing any package's code.

## Usage

```sh
hbc2js deps <bundle.hbc|app.apk> [--out <dir>] [--confirm] [--offline] \
  [--sigdb <dir>] [--no-shared-db] [--min-instr <n>] [--json]
```

- `<bundle.hbc|app.apk>` — a compiled Hermes bundle, or an Android APK
  containing one at the usual `assets/index.android.bundle` (or
  `assets/*.hbc`) path. Plain-JS (non-Hermes) bundles are not implemented
  yet (D18 — a future frontend); the CLI reports a clear error rather than
  guessing.
- `--out <dir>` — the decompile-project output directory. When at least one
  dependency is confirmed with confidence, `<dir>/package.json` is written
  (merged into an existing one) with a `dependencies` map. The project-local
  signature DB also lives under here: `<dir>/.hbc2js/sigdb/`.
- `--confirm` — run the npm confirm stage (§4 below). Requires network.
- `--offline` — skip npm registry search and the confirm stage entirely; the
  match and guess stages still run against whatever signature DB is
  reachable locally.
- `--sigdb <dir>` — override the project-local DB directory outright
  (instead of `<out>/.hbc2js/sigdb`).
- `--no-shared-db` — don't consult `tools/pkgsig/db` (this repo's starter
  set); useful to measure how much this task's own curated data is doing.
- `--min-instr <n>` — FLIRT-style minimum-instruction floor before a
  function hash is trusted at all (default 8, per
  `docs/PACKAGE-SIGNATURES.md` §2.4).
- `--json` — machine-readable `DepsReport` (see `src/deps/report.ts`) on
  stdout instead of the human table.

## Pipeline

1. **Module inventory** (`src/deps/inventory.ts`, `src/deps/dscan.ts`):
   parse the bytecode (never decompile it) and find every
   `__d(factory, id, deps)` registration structurally, by pattern-matching
   the `global` function's own decoded instructions. This recovers, for
   every Metro module: its factory function index, local numeric module id,
   ordered dependency-id array, nested closures, and the full set of
   string-literal constants used anywhere in the module — all for free,
   before any signature lookup.
2. **Match** (`src/deps/match.ts`, `src/deps/db.ts`): score every signature
   DB entry (across the three layers below) against the target's own
   per-function exact/fuzzy/string-set hashes and per-module factory hashes.
   Confidence tiers (`docs/PACKAGE-SIGNATURES.md` §5.4):

   | Tier | Condition |
   |---|---|
   | High | `moduleExactHits >= 3` (`STRONG_MODULE_HIT_COUNT`); or, for packages with **≥3 non-baseline hashed modules** (`TINY_PACKAGE_MODULE_TOTAL`), `moduleExactHits >= 2` **and** module coverage ≥5% **and** overall exact-function coverage ≥10%; or, for **tiny** packages (<3 modules), ≥5 exact-matched functions totalling ≥150 instructions; or overall exact-function coverage ≥90% (any package size) |
   | Medium | overall fuzzy coverage ≥50%, or exactly 1–2 module-exact hits |
   | Low | any exact/fuzzy hit at all, below Medium's floor |
   | None | zero hits after the `--min-instr` floor |

   **Threshold rationale (2026-08-30 tightening, `src/deps/match.ts`,
   `docs/PACKAGE-SIGNATURES.md` §6.6).** The pre-fix "high" rule
   (`moduleExactHits >= 1 && moduleCoverage >= 5%`) let a package with very
   few total modules reach "high" off a **single** coincidentally-matching
   module — measured live on `react-navigation-example-0.85.3` with the
   fixed bulk signature DB layered in: `js-md5` (2 total modules) hit 1/2 =
   50% coverage, `@emotion/react` (16–17 total modules) hit 1/16 ≈ 6%, both
   comfortably over the old flat 5% floor from one lone hash collision
   (FLIRT's classic single-collision risk, §1.2/§3.4). The fix requires
   **independent, multi-hit evidence, sized to the package**:
   - `STRONG_MODULE_HIT_COUNT = 3` — three or more independently-matching
     modules is strong evidence regardless of package size (unchanged).
   - `MIN_MODULE_HITS_FOR_COVERAGE_PATH = 2`, `MIN_MODULE_COVERAGE = 0.05`,
     `MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH = 0.10` — the
     percentage-of-modules path now needs *two* independent module hits,
     never one, **and** a non-trivial slice of the package's own function
     set (not just its module count) to have matched. Raising the hit floor
     from 1 to 2 alone eliminates both measured false positives (each had
     exactly 1 module hit); the function-coverage leg is defense in depth
     against a similar two-hit coincidence in a function-rich package.
   - `TINY_PACKAGE_MODULE_TOTAL = 3` — below this many total hashed modules,
     the percentage-of-modules path is disabled outright: a percentage of 1
     or 2 modules isn't statistically meaningful. Tiny packages instead need
     `MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS = 5` exact-matched functions
     totalling `MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR = 150` instructions —
     several sizeable functions matching exactly is not plausibly a
     coincidence, whereas one is — or `HIGH_EXACT_FUNCTION_COVERAGE = 0.9`
     (near-total package match, any size). `tests/gate/deps/match.test.ts`
     has both the two regression cases (js-md5/@emotion don't reach "high"
     off their real, single-hit collision) and two positive controls (the
     same two packages, given genuine multi-hit/broad-coverage evidence,
     still do) — see `tests/fixtures/sigdb/tiny-package-collision/` for the
     real signature files the collision was reproduced from.

   Per-module ownership is by exact factory hash, falling back to the
   factory's fuzzy hash **and** full string set together (≥8 instructions
   and ≥1 string, or ≥16 instructions; keys claimed by more than one real
   package never attribute) — this is what survives `hermesc -g`'s
   different register allocation (`ownerBasis` records which). Debug-only
   instructions (`AsyncBreakCheck`, `Debugger`) are elided from every hash.

   Only **High**-tier, non-baseline matches are reported as `confirmedDeps`.
   `react-foundation`/`react-native-foundation` (baseline artifacts that
   exist to be *subtracted* from other packages' signatures, never real npm
   packages themselves) are aliased back to `react`/`react-native` when no
   separate non-baseline file exists for that HBC version —
   `metro-toolchain-empty` has no npm equivalent and is dropped entirely.

3. **Guess** (`src/deps/guess.ts`, `src/deps/native-modules.ts`,
   `src/deps/apk.ts`): for every module the match stage left unattributed,
   collect weighted evidence:

   | Clue | Weight | Notes |
   |---|---|---|
   | `NativeModules.X`/`TurboModuleRegistry.get('X')` name, found as a string constant | 0.75 | Near-unique — curated in `native-modules.ts`. Version-independent, unlike a hash: this is often the *only* signal that still works once an app's actual library version has drifted from the signature DB's pinned version (see the Discord/Shopify measurement below). |
   | Known third-party SDK URL/API host | 0.40 | e.g. `api.stripe.com` -> `@stripe/stripe-react-native` |
   | Package-name string literal (curated name, `native-modules.ts`/host-map values) | 0.30 | A bare match (`"react-native-gesture-handler"` as a whole string) carries no version and, alone, is too generic to report (any code can contain a popular package's name). A `name@version`-shaped single literal (`"react-native-gesture-handler@2.14.0"`) carries a version and is the stronger, self-corroborating form — see the `hint` tier below. |
   | APK evidence (manifest permission, bundled `.so` name, asset file) | 0.20 | Only available for `.apk` input |
   | Dependency-edge propagation | up to 0.50, `0.2 * identified-dep-count` | Only fires when depOwners agree unanimously **and** either ≥2 deps are identified or ≥50% of the module's declared deps are — a single coincidental hit is deliberately not enough (this threshold was tightened after an early version attributed >5000 of Discord's own modules to "react-foundation" off a 1-in-7 dependency coincidence). Baseline-package owners never seed this clue. |
   | npm registry search fallback | 0.15 per hit | Network, `--offline` disables it; only tried when there's a name lead (a native-module-derived guess or a package-name-shaped string) |

   Guessed candidates are aggregated per package (not per module) in the
   report, and pass the precision rules from `docs/reviews/deps-v1.md`
   before being listed: a low-tier DB score is not evidence, a medium one
   counts only with an exact hit, anything reported needs ≥2 independent
   evidence kinds and confidence ≥0.5, npm-search never stands alone, and a
   package the DB scored explicitly negative (a signature at this HBC
   version with no exact function or module hit) is vetoed. What was
   weighed and dropped is in `suppressedGuesses` (`--json`). Anything already in `confirmedDeps` is excluded from the guessed
   list.

   **`hint` tier (2026-08-30, overseer decision after `docs/reviews/deps-v1.md`).**
   The ≥2-independent-kinds rule above correctly kills the false positives
   F1 found, but it also throws out every module whose *only* evidence is a
   single, highly specific clue — the common case once an app's actual
   library version has drifted far enough from the signature DB that no
   second corroborating hit ever fires (measured on Discord/Shopify: most of
   their real third-party dependencies show up as exactly one native-module
   name and nothing else). `src/deps/report.ts` now files a
   single-evidence-kind candidate as a `hint` — a new `DepsReport.hintedDeps`
   array, `src/deps/types.ts`'s `DepTier` — instead of silently suppressing
   it, but **only** when that one kind is high-specificity
   (`isHintEligibleEvidence`, `src/deps/guess.ts`): a curated native-module
   name, a curated API-host constant, or a package-name string literal that
   itself carries a version (the versioned row above). A bare package-name
   string with no version, an APK hint, a dependency-edge, or an npm-search
   hit are explicitly **not** eligible alone — those stay suppressed exactly
   as before, since none of them individually rules out coincidence the way
   a curated name/host/versioned-string match does. A `hint` is reported for
   visibility only: never merged into `package.json` (`packageJsonDependencies`
   only ever reads `confirmedDeps`), never counted in
   `attribution.percentAttributed`, and vetoed the same way a guess is if
   the DB scored the package explicitly negative or it's already confirmed.
   `tools/deps-truth.mjs` scores hint precision separately from guessed
   (`s.hinted`) — reported, not gated, same as guessed-tier precision,
   except on `rn-template-0.72` where `tests/gate/deps/truth.test.ts`
   asserts zero hint false positives (that fixture has no third-party
   dependencies at all, so any hint there would be one).

   Measured 2026-08-30 (offline, shared DB only — adding this tier changes
   *only* which suppressed candidates move to `hintedDeps`; `confirmedDeps`
   and `guessedDeps` are byte-identical before/after on both fixtures below,
   verified directly against a pre-hint-tier copy of `report.ts`, satisfying
   the D17d gate):

   | App | Hints | False positives (by name) |
   |---|---|---|
   | `rn-template-0.72` (release + `-g`) | 0 | 0 |
   | `react-navigation-example-0.85.3` | 1 (`react-native-pager-view`, via `RNCViewPager`) | 0 — this is one of the app's 9 real dependencies, previously either mis-tiered as "guessed" or silently suppressed depending on which precision-rule vintage produced a given number in this doc's older tables |
   | Discord (local corpus, counts only) | 8 (`@sentry/react-native`, `react-native-webview`, `@react-native-community/push-notification-ios`, `@react-native-masked-view/masked-view`, `@react-native-community/slider`, `@react-native-clipboard/clipboard`, `react-native-haptic-feedback`, `@react-native-community/netinfo`) | not verifiable without this proprietary app's real `package.json` (D16 C5: never fetched into this repo); all 8 are real, well-known RN library names with no plausible collision |
   | Shopify (local corpus, counts only) | 12 (`react-native-device-info`, `@stripe/stripe-react-native`, `react-native-keychain`, `react-native-fast-image`, `@react-native-masked-view/masked-view`, `react-native-webview`, `react-native-pager-view`, `@react-native-async-storage/async-storage`, `react-native-safe-area-context`, `react-native-localize`, `react-native-permissions`, `@react-native-community/netinfo`) | same caveat as Discord |

   Total distinct dependencies identified (confirmed + guessed + hinted) is
   close to, but not exactly, the pre-hint-tier counts in this doc's "Seed
   run" table below: Shopify matches exactly (3+4+12=19, same as that
   table's "4 confirmed + 15 guessed"; `react` moved from confirmed to
   guessed between runs, a wash on the total). Discord is one lower
   (3+5+8=16 vs. that table's "4 confirmed + 13 guessed"=17) because
   `@react-native-async-storage/async-storage` — one of the original 13
   native-module hits — no longer appears at all in this measurement (not
   even suppressed); this is shared-DB/match-tier churn from the concurrent
   D17c bulk-signature-build lane and the `match.ts` tier-threshold fix
   (both landed on this same day, independently of the `hint` tier), not
   something this tier's own logic touches. What this tier *does* do,
   confirmed directly (not inferred from the old table): a lone
   single-evidence-kind candidate that would otherwise have been silently
   suppressed now shows up in `hintedDeps` when its one kind is
   high-specificity, and `confirmedDeps`/`guessedDeps` are byte-identical
   with and without this tier's promotion logic on both Discord and Shopify
   (checked by diffing a report built with the promotion branch disabled
   against the real one, same method used for the two committed fixtures
   above).

4. **Confirm** (`src/deps/confirm.ts`, `--confirm` only): for the
   best-ranked guessed candidate per module, `npm pack <pkg>@<version>` (a
   plain tarball download — **never** `npm install`, so the candidate's own
   install-time scripts never run), extract by hand into a scratch RN
   project pinned to the target's detected RN version, bundle with Metro,
   compile with the matching `tools/hermesc/v<N>`, fingerprint, and match
   against the target. A candidate that clears High/Medium confidence has
   its signature written into the **project-local** DB (`<out>/.hbc2js/sigdb`)
   and the **user cache** (`~/.cache/hbc2js/sigdb`) so it's free on the next
   run. A candidate that fails to bundle/compile/match is recorded (not
   retried) in `<scratch>/confirm-failures.json`. Downloads are rate-limited
   (500ms between candidates by default).

5. **Report** (`src/deps/report.ts`): the human table / `--json` shape, plus
   `<out>/package.json` when confident. `DepsReport.moduleOwnership` is the
   module-id -> package mapping the M6 emitter needs (see "For M6" below).

## Signature DB layering (D17b)

Lookup order, first hit per `package@version`+HBC-version wins:

1. **project-local** — `<out>/.hbc2js/sigdb/` (or `--sigdb <dir>`). Written
   by `--confirm`; committing this with a decompilation project makes its
   results reproducible offline for anyone who checks it out later.
2. **user cache** — `~/.cache/hbc2js/sigdb/` (respects `XDG_CACHE_HOME`).
3. **shared** — `tools/pkgsig/db/` in this repo (or the installed npm
   package — it ships alongside `dist/`, see `package.json`'s `files`).
   Disabled by `--no-shared-db`.

One JSON file format across all three layers (schema 2 —
`src/deps/sigdb-types.ts`), so a project-local signature can be copied
straight into the shared set (see "Contributing a signature upstream"
below).

## Evidence-weight rationale and known limitations

- **Hash matching is HBC-version *and* library-version sensitive.**
  `docs/PACKAGE-SIGNATURES.md` §5.6 found that a signature DB built from a
  2026-era RN/react-navigation release attributes under 1% of Discord's and
  Shopify's modules, because those apps' actual bytecode — though tagged
  the same HBC major version — comes from a considerably older library
  release. The guess stage's native-module clue is the practical fix: it
  survives version drift completely, since native-module names essentially
  never change across a package's history.
- **`react-foundation`/`react-native-foundation` baseline files are not
  npm packages.** They exist purely so every *other* package's signature
  file can have Metro's shared runtime/polyfill functions subtracted out of
  it (`docs/PACKAGE-SIGNATURES.md` §5.2) — attributing an app's own
  first-party code to "react-foundation" via a weak dependency-edge
  coincidence is exactly the failure mode the tightened threshold above
  guards against.
- **Confidence never crosses into code substitution here.** `hbc2js deps`
  only ever reports; deciding whether to emit `require("pkg")` in place of
  decompiled code is M6's call, gated on `DepsReport.moduleOwnership`
  (confirmed-tier only).
- **Object-prototype safety**: every string-keyed lookup table this stage
  uses (`native-modules.ts`, the URL-host map, the APK asset-hint map) is a
  real `Map`, not a plain object literal — a bundle's own string constants
  are untrusted input, and a plain-object lookup keyed by a string like
  `"hasOwnProperty"` or `"constructor"` would silently return an
  `Object.prototype` member instead of `undefined` (`tests/gate/deps/guess.test.ts`
  has the regression test).

## For the M6 emitter (D19)

`DepsReport.moduleOwnership` (also reachable via
`matchInventory`+`buildReport`, or the whole pipeline via `runDeps`, all
exported from `src/index.ts`) is a flat array of
`{ localModuleId, factoryFunctionIndex, package, version }` — one entry per
Metro module confidently owned by a package in `confirmedDeps`. M6 should
skip emitting a `src/module_<id>.js` file for any id present here, and
instead ensure that package/version pair is in the emitted `package.json`'s
`dependencies` (already handled automatically when going through the CLI's
`--out` flag; call `packageJsonDependencies(report)` directly when embedding
`runDeps` programmatically).

## Seed run (2026-08-30)

Run offline (`--offline`, shared DB only — no `--confirm` in this session;
see "Confirm stage" note below) against the seed corpus:

| App | HBC | Functions | Modules | Confirmed deps | Guessed deps | % modules attributed |
|---|---|---|---|---|---|---|
| `rn-template-0.72` (committed fixture) | 94 | 4,199 | 435 | 2 (`react-native@0.72.17`, `react@18.2.0`) | 12 (all correctly low-confidence noise — none of these 12 are actually in this template) | 99.3% |
| `react-navigation-example-0.85.3` (fetched fresh) | 98 | 15,551 | 1,782 | **9/9** of this app's real dependencies, all High | 1 (`react-native-pager-view`, a real dependency the starter DB doesn't cover) | 61.9% |
| Bloomberg (local corpus) | 96 | 58,932 | 4,995 | 9 | 20 | 51.2% |
| Xbox (local corpus) | 96 | 59,278 | 6,435 | 10 | 21 | 36.5% |
| **Discord** (local corpus) | 98 | 120,522 | 17,037 | 4 (`react`, `react-native`, `@react-navigation/{stack,native}`) | **13** real native-module hits (gesture-handler, reanimated, screens, safe-area-context, sentry, webview, push-notification-ios, masked-view, slider, clipboard, haptic-feedback, netinfo, async-storage) | 0.75% |
| **Shopify** (local corpus) | 98 | 97,752 | 25,439 | 4 | **15** real native-module hits (incl. stripe-react-native, device-info, keychain, fast-image, pager-view, localize, permissions) | 0.97% |
| Teams (local corpus) | — | — | — | *(no bundle found at the standard path — ships several `hermes.android.bundle` micro-frontends instead, per `docs/PACKAGE-SIGNATURES.md` §2.5)* | | |
| Pinterest (local corpus) | — | — | — | *(no RN bundle in this APK at all — confirmed non-RN or fully-native)* | | |

**Discord and Shopify, specifically** (previously documented at <1% module
attribution and only 2 packages identified at all,
`docs/PACKAGE-SIGNATURES.md` §5.6): module-count attribution is still low
(0.75%/0.97% — most of both apps' bytecode is either first-party or a
library version too far from the starter DB's pinned versions to hash-match
at all), but the number of **distinct dependencies identified** went from 2
to 17 and 19 respectively, entirely via the guess stage's native-module
evidence, which is immune to the version-drift problem that caps the match
stage. This is the honest state of "now covered": dependency *identification*
improved substantially; module-count attribution for these two specifically
needs either a newer-vintage signature DB entry for their actual (unknown,
older) RN/library releases, or `--confirm` against a guessed version.

Full per-app numbers are reproducible via `HBC2JS_TIER=sweep node --test
tests/sweep/deps/corpus.test.ts` (skips gracefully, INCONCLUSIVE not
failure, when `~/hbc2js-local-corpus` or the fetched
`react-navigation-example` fixture is absent). Local-corpus APKs are never
committed, and nothing derived from them was copied into `tools/pkgsig/db`
(D16 C5, D17b: only public-npm-package fingerprints ever enter the shared
DB).

**Confirm stage**: implemented (`src/deps/confirm.ts`) and typechecked, but
not exercised end-to-end in this seed run within the time budget available —
each candidate needs a from-scratch scratch RN scaffold (`npm install
react-native@<version>`, ~30-60s the first time) plus a real `npm pack` +
Metro bundle + `hermesc` compile per candidate, and this session's seed run
prioritised breadth (match+guess across the whole corpus, which needed no
network) over depth on any one candidate. Follow-up: run `hbc2js deps
--confirm` for a handful of the guessed candidates above (e.g. Discord's
`@sentry/react-native`) to validate the pipeline against a real network
target and grow the shared DB with genuinely version-matched signatures for
these two apps' actual (older) toolchain.

## Ground truth (D17d)

`tools/deps-truth.mjs <bundle.hbc> <bundle.map> --bundle-js <bundle.js>
[--write-truth deps-truth.json] [--also-hbc <debug.hbc>]` derives per-module
truth from Metro's source map (`--sourcemap-output`): each minified `__d(...)`
line ends in `},<id>,[deps]);`, the map gives that line's source path, and
`node_modules/<pkg>/package.json` gives the version. The compact
`deps-truth.json` (module id → package@version, direct deps from the app's
package.json, transitive edges, .hbc sha256s) is what a fixture commits;
`tools/deps-truth.mjs <bundle.hbc> deps-truth.json` scores a report:
precision/recall for the confirmed and guessed tiers, per-module accuracy,
false positives and misses by name. Gate: `tests/gate/deps/truth.test.ts`
(confirmed-tier false positives must be 0 on release *and* `-g`); sweep:
`tests/sweep/deps/truth-react-navigation.test.ts` (skips until that
fixture's map/truth exist locally — its fetch.sh clones the react-navigation
monorepo and runs `pnpm install` + `expo export`, which is not cheap; add
`--source-maps` to the export and run the truth tool on the result).

Fixture: `tests/fixtures/bundles/rn-template-0.72/truth/` (a rebuild of the
template with the map; `BUILD.md` has the recipe). Numbers, 2026-08-30:

| | before (1b679a3) | after |
|---|---|---|
| release: confirmed | react-native@0.72.17, react@18.2.0 (precision 100%, direct recall 100%) | same |
| release: guessed | 12 packages, **0 true** (stack, react-redux, native, async-storage, toolkit, axios, immer, lodash, moment, gesture-handler, reanimated, zustand) | 0 reported, 1 suppressed (`--json` lists it) |
| release: per-module | 424/435 attributed | 334/432 library modules correct (77.3%), 51 attributed to the package that depends on them, 40 wrong, 7 unattributed; 0 app modules attributed |
| `-g`: confirmed | **none**, rn=null, 3.7% attributed, npm-search junk | react-native@0.72.17, react@18.2.0, rn=0.72.17, 0 guessed |
| `-g`: per-module | 0 | 325 correct (75.2%), 48 via dependent, 40 wrong, 19 unattributed; 0 disagreements with the release build |

Recall over *all* 20 truth packages is 10% by construction: the DB
fingerprints `react-native` with its dependencies bundled (minus the three
baselines), so `@babel/runtime`, `invariant`, `prop-types`, `scheduler`, ...
are reported under `react-native` (the "via dependent" column). The 40
"wrong" modules are `@babel/runtime`/`prop-types` helpers attributed to
`react-native` while truth says another dependent, 4 `react` modules owned by
the `react-native` signature, and 1 RN module the `@react-navigation/stack`
signature still contains (baseline-subtraction gap). The `-g` residue (19
unattributed) is string-less factories under 16 instructions, where the
fuzzy+string fallback is deliberately not trusted.

### `match.ts` tier-threshold fix (2026-08-30, follow-up to §6.6)

Re-ran both fixtures after the tier-threshold fix above. `rn-template-0.72`
never exercises the fixed bug (shared DB only, no tiny-package collision in
its dependency tree) and is confirmed byte-identical via
`tools/deps-truth.mjs` before → after:

| | before | after |
|---|---|---|
| `rn-template` release: confirmed | react-native@0.72.17, react@18.2.0 (precision 100%, recall 10% of all / 100% of direct) | unchanged |
| `rn-template` release: per-module | 334/432 correct (77.3%), 51 via dependent, 40 wrong, 7 unattributed | unchanged |

`react-navigation-example-0.85.3` has no committed `deps-truth.json` yet (its
map/truth need a live `expo export --source-maps`, `tests/sweep/deps/truth-react-navigation.test.ts`
skips until that exists), so this fixture's numbers below are `confirmedDeps`
name/version counts against the known real dependency set (the same 9
packages `tests/sweep/deps/corpus.test.ts` asserts against the shared DB
alone), not a formal source-map score — measured offline, shared DB +
2026-08-30's fixed bulk sample layered in as project-local (`tools/pkgsig/bulk`'s
`sigdb-20260830-fixed.tar.zst`, per `docs/PACKAGE-SIGNATURES.md` §6.6.3):

| | before | after |
|---|---|---|
| confirmed-tier entries | 17 (9 correct incl. 1 wrong-version `@react-navigation/native` duplicate — §4 S3, pre-existing, not this bug; 8 wrong: `js-md5` ×5 versions, `@emotion/react` ×3) | 9 (same 9 correct entries; 0 wrong) |
| confirmed-tier precision (by distinct package name) | 8/10 = 80% | 8/8 = 100% |
| confirmed-tier false positives | `js-md5`, `@emotion/react` | **none** |

All 9 real dependencies this scenario recovers (`@react-navigation/stack`,
`react-native-gesture-handler`, `react-native-reanimated`,
`@react-navigation/native`, `react-native-screens`,
`react-native-safe-area-context`, `react-native`, `react`, plus the
already-flagged wrong-version `@react-navigation/native` duplicate) keep
their exact `moduleExactHits`/`exactCoverage` numbers unchanged — the fix
only removes the two false positives, per the positive-control tests in
`tests/gate/deps/match.test.ts`. (`@react-native-async-storage/async-storage`,
one of the 9 packages the shared-DB-alone `corpus.test.ts` sweep test finds,
does not appear in *this* bulk-layered scenario either before or after this
fix — its bulk-built signature at the exact matching version was built from
a different Metro/RN scaffold than the fixture's own 0.85.3 and scores 0
exact hits, so `src/deps/db.ts`'s per-`package@version` layering precedence
shadows the shared DB's better-matching copy of the same version; a
pre-existing `db.ts` layering risk, independent of this tier-threshold fix
and out of `match.ts`'s ownership.)

### `--confirm` precision/recall (2026-08-30, D17d)

Live run of `hbc2js deps --confirm --no-shared-db` (real npm registry, empty
project-local DB, no bulk shared-DB layer) against
`react-navigation-example-0.85.3`, scored against a freshly-regenerated
`deps-truth.json` by `tests/sweep/deps/confirm-react-navigation.test.ts`
(~140 s, real network, real `npm install`/Metro/`hermesc` per candidate):

| | |
|---|---|
| confirmed-tier reported | 2 (`@react-navigation/native`, `react-native-reanimated`) |
| confirmed-tier precision | 100% (2/2, zero false positives) |
| confirmed-tier recall | 2.7% of all 75 truth packages / 3.3% of the 60 direct ones |
| version mismatch | `@react-navigation/native`: reported `8.0.0-alpha.21`, truth `8.0.0-alpha.44` (package still counted a true positive; exact version differs) |

Recall is noisy run to run — purely from network-side version selection,
not a code regression. `resolveCandidateVersion`'s "nearest npm release by
date" fallback (§4 above) can land on a nightly build of a fast-moving
package (`react-native-gesture-handler`, `react-native-screens`,
`react-native-safe-area-context`, and `react-native-pager-view` all publish
nightlies continuously); a nightly frequently fails to bundle at all (a
missing/renamed transitive dependency) or ships too little of its own code
to clear a confidence tier, so `--confirm` correctly reports nothing for it
rather than a false positive. A separate manual run the same day (recorded
in agent scratch, not committed) confirmed all 5 of those plus the 2 above,
7 total, still zero false positives. Precision has been 100% in every run
observed; only recall varies. The sweep test's own `>= 5 confirmed` floor
is therefore itself somewhat network-luck-dependent — noted here and in
`docs/BUGS.md`, not tightened (out of this task's scope; the fix would be
version-selection logic in `src/deps/confirm.ts`, not this doc).

## Shared DB size

`tools/pkgsig/db` is ~16 MB as of this task (40 signature files + baselines,
`docs/PACKAGE-SIGNATURES.md` §5.3/§5.5) — comfortably under the ~40 MB
budget. If a single package's signature file grows unusually large (e.g. a
package that transitively re-includes a lot of code none of the three
foundation baselines cover, `docs/PACKAGE-SIGNATURES.md` §5.3's own
`@react-navigation/stack`@HBC98 example at 1.4 MB), note why in the commit
rather than silently letting the budget creep.

## Contributing a signature upstream

A project-local DB uses the exact same file format as the shared one. To
promote a `--confirm`-produced signature: copy
`<out>/.hbc2js/sigdb/<pkg>@<version>__hbc<N>.json` into `tools/pkgsig/db/`
(or run `hbc2js deps --confirm --sigdb tools/pkgsig/db <bundle>` directly
against it) — but **only for public npm package code**. Never copy anything
whose provenance traces back to a proprietary app's own bundle (the local
corpus in this seed run never contributed anything to `tools/pkgsig/db`).

## Tests

- `tests/gate/deps/inventory.test.ts` — module-graph recovery against the
  committed `rn-template-0.72` fixture.
- `tests/gate/deps/db.test.ts` — layering precedence and the on-disk format.
- `tests/gate/deps/match.test.ts` — the offline gate check: react +
  react-native must resolve at High confidence, lodash must not; plus the
  D17d tiny-package-collision regression (`js-md5`/`@emotion/react` must not
  reach High off one coincidental module hit, but must still reach it given
  genuine multi-hit evidence) against the committed
  `tests/fixtures/sigdb/tiny-package-collision/` real signature files.
- `tests/gate/deps/guess.test.ts` — evidence-scoring unit tests, including
  the `Object.prototype`-pollution regression test and the versioned/bare
  `package-name-string` clue plus `isHintEligibleEvidence` (`hint` tier).
- `tests/gate/deps/apk.test.ts` — APK-hint mapping unit tests.
- `tests/gate/deps/precision.test.ts` — the guess-aggregation precision
  rules, plus the `hint`-tier promotion rules (native-module/url-host alone,
  versioned vs. bare package-name-string, dependency-edge/apk/db-match never
  qualify alone, DB-negative veto and confirmed-package exclusion apply to
  hints too, and a hinted module is dropped from the printed unattributed
  list without affecting `attribution.unattributedModules`).
- `tests/gate/deps/robustness.test.ts` — `-g` build: AsyncBreakCheck elision,
  same confirmed deps/RN version as release, ≥95% of its module attribution.
- `tests/gate/deps/truth.test.ts` — D17d ground truth on the template
  (release and `-g`): confirmed-tier false positives = 0, hint-tier false
  positives = 0 (asserted, not just reported, on this fixture since it has
  no third-party dependencies at all).
- `tests/gate/deps/confirm.test.ts` — `confirmCandidates`'s pure helpers
  (dedup, baseline subtraction, RN-version-from-baseline-filename fallback,
  nearest-by-date version resolution) plus an end-to-end run against a
  stubbed `npm`/`npx` (no network): write-back + D17b layering.
- `tests/gate/cli/deps.test.ts` — the `hbc2js deps` CLI end-to-end
  (text/`--json`/`--out`/error handling).
- `tests/sweep/deps/corpus.test.ts` — the seed-run corpus, skipped
  (INCONCLUSIVE) when its inputs are absent.
- `tests/sweep/deps/truth-react-navigation.test.ts` — D17d on
  react-navigation-example, skipped until its map/truth are generated.
- `tests/sweep/deps/confirm-react-navigation.test.ts` — `--confirm` against
  react-navigation-example with a real npm registry, `--no-shared-db`;
  skipped (INCONCLUSIVE) without the sweep tier or the fixture's
  `.hbc`/`deps-truth.json`. Numbers: "`--confirm` precision/recall" above.
