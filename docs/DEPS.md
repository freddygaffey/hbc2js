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
   | High | `moduleExactHits >= 3`, or `moduleExactHits >= 1` **and** module coverage ≥5%, or overall exact-function coverage ≥90% |
   | Medium | overall fuzzy coverage ≥50%, or exactly 1–2 module-exact hits |
   | Low | any exact/fuzzy hit at all, below Medium's floor |
   | None | zero hits after the `--min-instr` floor |

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
   | APK evidence (manifest permission, bundled `.so` name, asset file) | 0.20 | Only available for `.apk` input |
   | Dependency-edge propagation | up to 0.50, `0.2 * identified-dep-count` | Only fires when depOwners agree unanimously **and** either ≥2 deps are identified or ≥50% of the module's declared deps are — a single coincidental hit is deliberately not enough (this threshold was tightened after an early version attributed >5000 of Discord's own modules to "react-foundation" off a 1-in-7 dependency coincidence). Baseline-package owners never seed this clue. |
   | npm registry search fallback | 0.15 per hit | Network, `--offline` disables it; only tried when there's a name lead (a native-module-derived guess or a package-name-shaped string) |

   Guessed candidates are aggregated per package (not per module) in the
   report; anything already in `confirmedDeps` is excluded from the guessed
   list.

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
  react-native must resolve at High confidence, lodash must not.
- `tests/gate/deps/guess.test.ts` — evidence-scoring unit tests, including
  the `Object.prototype`-pollution regression test.
- `tests/gate/deps/apk.test.ts` — APK-hint mapping unit tests.
- `tests/gate/cli/deps.test.ts` — the `hbc2js deps` CLI end-to-end
  (text/`--json`/`--out`/error handling).
- `tests/sweep/deps/corpus.test.ts` — the seed-run corpus, skipped
  (INCONCLUSIVE) when its inputs are absent.
