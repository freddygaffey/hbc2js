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

   **Cross-package hash ambiguity (2026-08-31, §6.7 below).** Every exact
   hit counted above (`exactHits`, `moduleExactHits`) must also be
   *unambiguous*: a hash claimed by **≥20 distinct non-baseline package
   names** anywhere in the loaded DB is excluded from every package's own
   count, full stop — shared evidence that broad is not proof for any one
   claimant. Found necessary only once the 32,708-signature bulk DB (D17c)
   was layered in: whole families of npm packages that share near-identical
   generated boilerplate (the `ljharb` ES-shim family — `is-weakref`,
   `is-finalizationregistry`, `hasown`, `is-data-descriptor`, ... — plus, more
   pervasively, Babel's own runtime helpers, byte-identical across a huge
   fraction of all Babel/TS-compiled npm packages) independently reached
   "high" off dozens of hits that, on inspection, every sibling package
   claimed identically — live-measured as ~750 simultaneous false
   "confirmed" dependencies for one real corpus app. The threshold is 20, not
   a smaller number: a real, *legitimate* multi-package dependency chain
   (Metro has no export-level tree-shaking, so `@react-navigation/stack`'s
   own signature genuinely still contains code shared with
   `react-native-gesture-handler`/`react-native-reanimated`/
   `react-native-safe-area-context`/`@react-navigation/native`, all real
   dependencies bundled together) measured up to 7 distinct package names
   sharing one hash even in the small curated starter DB alone — an earlier
   cutoff of 3 was tried and destroyed that real signature entirely
   (`moduleExactHits` 292→0, tier high→low, on a dependency
   `react-navigation-example`'s own ground truth confirms is present). 20
   sits clear of both measured populations: comfortably above the largest
   legitimate chain found (7), far below the smallest measured
   boilerplate-family collision (55, measured on the bulk DB).

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

   **Version-tolerant matching: the `fuzzy-only` tier (2026-08-31, issue
   #14/F1).** The two ownership bases above both still require the module's
   exact hash (or its fuzzy hash + full string set) to appear in the DB
   verbatim — brittle against version drift, since a signature DB rarely
   has the *exact* library version an app shipped (D17c's bulk DB has
   `react-native` at 0.70.6/0.72.8/0.76.5 for HBC96, for example, never the
   0.73.x a real HBC96 app actually ships — issue #14's own headline
   finding: exact-hash-only matching against the nearest sampled version
   recognised only 88/422 `react-native` modules on a real production
   bundle). `ownerBasis` gets a third value, `"fuzzy-only"`: a module whose
   factory has **no** exact or fuzzy+strings match falls back to its bare
   opcode-sequence (fuzzy) hash *alone* — most of a library's functions
   don't change source between adjacent minor/patch versions, so their
   mnemonic sequence (every operand, including string/bigint content,
   already stripped) is often identical even when the exact hash and string
   set are not. Far more collision-prone than the other two bases (stripping
   every literal throws away the strongest disambiguating signal), so it
   carries two independent safeguards:
   1. **Package-level trust gate** — only from a package whose own score
      already reached medium/high confidence some other way (real exact-hash
      evidence, or broad fuzzy coverage); an isolated fuzzy collision from a
      package with zero other evidence never attributes a module by itself.
   2. **Size floor** — a factory below `MIN_FUZZY_ONLY_FACTORY_INSTR` (24)
      instructions is never trusted this way, larger than the fuzzy+strings
      fallback's own 16-instruction floor since there is no string-set
      corroboration to lean on.

   A key claimed by more than one distinct non-baseline package is still
   never trusted, exactly like `fuzzy+strings`. This tier is *not* headlined
   as separately from "matched" in `attribution` (both feed
   `matchedInstrWeight`/`matchedModules` alike — see the by-weight metric
   below), but `attribution.matchedInstrWeightByBasis` breaks the weight out
   by basis so a report can see how much of "matched" rests on it.

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

### The D17c bulk DB (fetch, layering, and a real data-hygiene bug)

`tools/pkgsig/fetch-db.sh` fetches the D17c bulk signature DB (built on
`deb`, `docs/DECISIONS.md` D17c — ~2,000 packages across HBC 94/96/98/99,
32,708 signatures as of the first `2026-08-30` build) and unpacks it into a
local directory in the same schema-2 format as every other layer:

```sh
# From a public URL, once one exists:
HBC2JS_SIGDB_SOURCE=https://.../sigdb-20260830-partial.tar.zst \
  tools/pkgsig/fetch-db.sh [dest-dir]
# Straight from the build host (scp), before anything is published:
HBC2JS_SIGDB_SOURCE=deb:~/hbc2js-bulk/dist/sigdb-20260830-partial.tar.zst \
  tools/pkgsig/fetch-db.sh [dest-dir]
```

`dest-dir` defaults to the user-cache layer (`~/.cache/hbc2js/sigdb`), so a
plain `hbc2js deps <bundle>` picks it up automatically once fetched; pass an
explicit `dest-dir` and `--sigdb <dest-dir>` (or point it at
`<out>/.hbc2js/sigdb` before running `deps`) to layer it as project-local
instead, ahead of the shared starter set.

**Data hygiene, found measuring this task's baseline (2026-08-31, issue
#14).** The first archive (`sigdb-20260830-partial.tar.zst`, a partial/
interrupted build per its own filename) has 353 of its 32,708 files
(1.1%) with baseline subtraction (`docs/PACKAGE-SIGNATURES.md` §5.2)
silently skipped — `subtractedBaselines: []` on a non-baseline package,
meaning its function set is still an essentially-unsubtracted copy of
Metro's runtime plus, when the build scaffold pulled it in, all of
react/react-native. Verified directly: `@amplitude/react-native@2.17.0`'s
hbc94 file carries 4,244 functions, of which 4,150 exact-hash-match the
committed `rn-template-0.72` fixture — a fixture with **no** dependency on
`@amplitude/react-native` at all. Unfiltered, layering this archive turned a
clean 2-confirmed-dependency report into 134 "confirmed" dependencies, 133
of them false, entirely from a handful of contaminated files winning
exact-hash collisions against every real bundle's own react-native code —
exactly the failure mode `tools/pkgsig/bulk/baseline-subtract.mjs`'s own
header describes; these particular files just never went through it.

`fetch-db.sh` always runs `tools/pkgsig/filter-unsubtracted.mjs` on the
destination directory after extracting, which quarantines any such file into
`dest-dir/_rejected-unsubtracted/` (kept for audit, never read by
`loadSignatures` — it only reads `<dir>/*.json` and `<dir>/_baselines/*.json`)
before the DB is considered ready. Run it by hand against any existing sigdb
directory with `node tools/pkgsig/filter-unsubtracted.mjs <dir>`; it's
idempotent. This is deliberately *not* a change to `src/deps/db.ts`'s
`loadSignatures` itself — dozens of gate tests construct minimal
hand-written `SigDbFile` fixtures that don't bother populating
`subtractedBaselines` (irrelevant to what they test), and a cold
`--confirm` run with no baseline files reachable in any DB layer yet can
legitimately produce the same empty-array shape without being contaminated
data — so the check belongs at bulk-archive ingestion time, not as a
blanket load-time policy.

Even after quarantining those 353 files, layering all ~32,000 remaining
ones exposed a second, distinct problem — see "Cross-package hash
ambiguity" above (§6.7): whole families of npm packages sharing
near-identical generated boilerplate independently reaching "high"
confidence off the same shared evidence. Both fixes are necessary together;
neither alone was sufficient (measured: unsubtracted-file quarantine alone
still left 6 real false positives on `rn-template-0.72` and ~750 on a real
corpus app; the ambiguity threshold alone, without quarantining first, would
still be scoring against contaminated function sets).

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

## `DepsReport` JSON schema (issue #14's open Q)

`--json` prints `DepsReport` (`src/deps/report.ts`) verbatim. Field names a
prior consumer got wrong by guessing (`.name` instead of `.package`,
`.strings` instead of `.topStrings`) are exactly why this section exists —
read this before writing a `--json` consumer rather than re-deriving the
shape from the human table.

| Field | Type | Meaning |
|---|---|---|
| `input` | `string` | The path passed on the CLI. |
| `hbcVersion` | `number` | Parsed Hermes bytecode version (never guessed from the RN version — the reverse). |
| `totalFunctions`, `totalModules` | `number` | Whole-bundle counts from the module inventory. |
| `reactNativeVersion` | `string \| null` | Best-guess RN version, from the highest-confidence matched `react-native`/`react-native-foundation` signature; `null` if none matched at all. |
| `reactNativeVersionConsistentWithHbc` | `boolean \| null` | F4 (issue #14): `null` when `reactNativeVersion` is `null` (nothing to reconcile) or the parsed `hbcVersion` has no documented RN range; otherwise whether `reactNativeVersion` falls inside the range `docs/TOOLCHAIN.md`'s table documents for this `hbcVersion` (e.g. HBC96 → RN 0.73.x-0.81.x). `false` is the issue's own repro case: `react-native@0.72.17` matched against a real HBC96 bundle. |
| `reactNativeVersionExpectedRange` | `string \| null` | Human-readable RN range for this `hbcVersion` (populated whenever one is known, not only on a mismatch), e.g. `"RN 0.73.x-0.81.x"`. |
| `confirmedDeps` | `ConfirmedDep[]` | `{ package, version, confidence, modulesCovered, moduleTotal, source }` — `package` (not `.name`), High-tier or `--confirm`-verified. Written into `package.json`. |
| `guessedDeps` | `GuessedDep[]` | `{ package, version, confidence, modules, evidence }` — evidence-scored leads clearing the precision rules (≥2 independent evidence kinds, confidence ≥0.5). Never written into `package.json`. |
| `hintedDeps` | `HintedDep[]` | `{ package, version, confidence, evidenceKind, evidence }` — single-evidence-kind leads kept only when that one kind is high-specificity. Reported for visibility only. |
| `suppressedGuesses` | `SuppressedGuess[]` | `{ package, confidence, evidence, reason }` — what the precision rules weighed and dropped, and why. |
| `unattributedModules` | `UnattributedModule[]` | `{ localModuleId, factoryFunctionIndex, instrCount, topStrings }` — `topStrings` (not `.strings`), the module's first 8 string constants; likely first-party app code. |
| `moduleOwnership` | `ModuleOwnership[]` | `{ localModuleId, factoryFunctionIndex, package, version }` — flat module→package map, **confirmed-tier owners only** (the M6 contract, see below). |
| `attribution.totalModules`/`matchedModules`/`guessedModules`/`unattributedModules`/`percentAttributed` | `number` | Module-**count** attribution (pre-existing). |
| `attribution.totalInstrWeight`/`matchedInstrWeight`/`guessedInstrWeight`/`hintedInstrWeight`/`unattributedInstrWeight` | `number` | F2 (issue #14): the same split, summed by `instrCount` instead of counted — see "By-instruction-weight metric" below. |
| `attribution.matchedInstrWeightByBasis` | `{ exact, fuzzyStrings, fuzzyOnly }` | `matchedInstrWeight` broken out by `ModuleAttribution.ownerBasis` — how much of "matched" rests on the version-tolerant `fuzzy-only` tier. |
| `attribution.percentAttributedByWeight` | `number` | By-weight mirror of `percentAttributed` (matched+guessed). |
| `attribution.percentVerifiedByWeight` | `number` | **The headline number.** Matched (signature-verified, any basis) only, by weight — excludes guessed/hinted deliberately, since only a real signature match ever justifies code substitution (D17a). |

Two related, but distinct, module-level shapes exist below `DepsReport`
(reachable via `matchInventory`/`buildReport` directly, not part of
`DepsReport` itself): `MatchReport.moduleAttributions` (`src/deps/match.ts`)
is the *raw* per-module match-stage result (`owners`, `ownerBasis`,
`instrCount`, ...) for every module, matched or not; `DepsReport`'s own
`moduleOwnership` is the much narrower, M6-facing filtered view (confirmed
packages only). Don't conflate `moduleAttributions.owners` (raw hash-match
package@version strings, can be empty, ambiguous, or baseline-aliased) with
`moduleOwnership` (already resolved to one package/version per module,
confirmed-tier only).

### By-instruction-weight metric (F2)

Module-**count** attribution (`percentAttributed`) can look healthy while
the bundle's actual bytecode is barely touched — a real app's modules vary
hugely in size, and a handful of huge unmatched app modules (or a handful of
tiny matched ones) skew a raw count arbitrarily. This is issue #14's own
headline finding, stated in code-weight terms: "stripped only ~1.6% of code
by instruction weight" on a real HBC96 production bundle, while module-count
attribution alone read far better. `attribution`'s `*InstrWeight` fields
(above) sum `ModuleAttribution.instrCount` — already computed by the match
stage — instead of counting modules 1:1, giving the same
matched/guessed/hinted/unattributed split weighted by how much bytecode each
category actually represents. `percentVerifiedByWeight` is the number to
headline: what fraction of the bundle's real bytecode is hash-verified
library code a future M6 pass could actually strip.

`tools/deps-truth.mjs`'s `scoreAgainstTruth` mirrors this at the
*known-library-module* granularity too (`perModuleByWeight`, alongside the
pre-existing module-count `perModule`) — recall over the instructions truth
says belong to a real dependency, not just their count — and
`formatScore`/the human CLI table (`formatReportText`) both print the
headline weight line.

### RN version reconciliation (F4)

`detectReactNativeVersion` (`src/deps/report.ts`) picks the best-confidence
matched `react-native`/`react-native-foundation` signature's version — but
exact-hash matching against a *near-but-wrong* version, sampled because the
signature DB doesn't have the app's real one, can outrank the truth on raw
`exactCoverage` alone (issue #14's repro: `react-native@0.72.17` — an HBC94
version — matched against a real HBC96 (RN 0.73.x) bundle). `HBC_TO_RN_RANGE`
(`src/deps/report.ts`, from `docs/TOOLCHAIN.md`'s own version table) gives
each HBC version's documented RN release range; `detectReactNativeVersion`
now prefers a range-consistent candidate over an inconsistent one when both
are tied at the same confidence tier, and `reconcileReactNativeVersion`
always reports whether the version actually picked is consistent —
surfaced as `reactNativeVersionConsistentWithHbc`/`reactNativeVersionExpectedRange`
in `DepsReport` and as an inline `WARNING` line in both the human table
(`formatReportText`) and `tools/deps-truth.mjs`'s score output when it
isn't. This never silently fixes a wrong match — an inconsistent version can
still be the best (or only) evidence available and is still reported, just
flagged.

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

### Bulk-DB (D17c) recall, before → after (2026-08-31, issue #14 F1)

Honest before/after, both by module count and by instruction weight
(`tools/deps-truth.mjs`, offline, no `--confirm`), on the two fixtures with
committed ground truth. **Before** = shared starter DB only (`tools/pkgsig/db`,
~40 packages); **after** = + the D17c bulk DB (32,708 signatures, 353
unsubtracted files quarantined per "The D17c bulk DB" above) layered as
`--sigdb`, with the version-tolerant `fuzzy-only` tier and the cross-package
ambiguity gate (both above) also in effect — these two fixtures were
specifically chosen because the starter DB was already built close to their
exact toolchain, so neither shows a *dramatic* swing; the real headline case
this whole task exists for (a wrong-version exact-hash match on a real HBC96
production bundle) is the informational spot-check below instead.

| | rn-template-0.72 (HBC94) before | after | react-navigation-example-0.85.3 (HBC98) before | after |
|---|---|---|---|---|
| confirmed (module count) | 2, 100% precision | 2, 100% precision | 9, 100% precision | 10, 80% precision (2 FP: `web-streams-polyfill`, `twrnc`) |
| module-count attribution | 425/435 (97.7%) | 425/435 (97.7%) | 1033/1782 (58.0%) | ~1033/1782 (unchanged materially) |
| **verified by instruction weight** | **91305/92576 = 98.6%** | **91310/92576 = 98.6%** | **194226/324954 = 59.8%** | **194550/324954 = 59.9%** |
| per-library-module weight accuracy | 78001/92227 = 84.6% correct | 77951/92227 = 84.5% | 100012/292497 = 34.2% correct | 99291/292497 = 33.9% |

Both fixtures were already close to saturated by the curated starter DB
(built specifically against rn-template's and react-navigation-example's own
toolchains), so the bulk layer adds only marginal weight-recall here and
introduces 2 new false positives on react-navigation-example (`twrnc`,
`web-streams-polyfill` — both real npm packages whose bulk-built signature
happens to collide; not re-tuned further within this task's time budget,
flagged as residual risk). **This is the expected, honest result for these
two fixtures specifically** — they are not the scenario the bulk DB exists
to fix.

**Informational spot-check reproducing the actual headline scenario**
(Bloomberg, local corpus, HBC96, real production RN 0.73.x bundle — counts
only, no ground truth available, D16 C5: never fetched into this repo):

| | starter DB only | + filtered bulk DB |
|---|---|---|
| `react-native` version detected | `0.72.17` — **flagged inconsistent** (`reactNativeVersionConsistentWithHbc: false`, expected `RN 0.73.x-0.81.x`) | same (bulk DB has no exact 0.73.x for HBC96 either — the DB gap issue #14 named, `docs/PACKAGE-SIGNATURES.md` §6.7's own note: "VERSION GAPS ... no 0.73.x") |
| module-count attribution | 557/4995 (11.2%) | 951/4995 (19.0%) |
| **verified by instruction weight** | **29857/1065885 = 2.8%** | **70362/1065885 = 6.6%** |
| distinct confirmed dependency names | 12 | 80 (unverifiable precision, but recognisable real RN libraries: `react-native-reanimated`, `react-native-gesture-handler`, `@react-navigation/{stack,native}`, `react-native-safe-area-context`, `react-native-screens`, `@react-native-firebase/app`, `@sentry/react-native`, `react-native-svg`, ... — the same real packages the pre-bulk-DB seed run found via the guess stage alone) |

Verified weight-recall roughly doubling (2.8%→6.6%) and confirmed-dependency
identification going from 12 to 80 distinct names is real signal that F1
works on the scenario it targets — but 6.6% is nowhere near the ~85% "React
apps are mostly reusable library bloat" target from this task's brief. The
gap is the DB's version coverage, not the matching logic: this HBC96 app's
real react-native release (0.73.x-era, per the flagged inconsistency) simply
isn't in the 32,708-signature archive at all (its `react-native` entries for
HBC96 are 0.70.6/0.72.8 only) — closing that gap needs either a wider bulk
build (more sampled versions per HBC era) or `--confirm`'s on-demand npm
fetch against the app's *actual* detected version, not a further matching-
algorithm change. See the top-level report for this task's full recall
write-up.

### Round 2 (2026-09-01, QUEUE item 6)

`tools/pkgsig/bulk/candidates.mjs` built `tools/pkgsig/bulk/candidates.json`
from repo truth fixtures (20 pairs), a static RN 0.73.0-0.76.x patch range
(36 pairs), a curated ~141-package RN-ecosystem list (versions hand-pinned,
not scraped), and a Service NSW `hbc2js deps --json` report (4 pairs from
`hintedDeps`/`guessedDeps`; 0 unresolved node_modules-path/require()
string names found — Metro's production bundle carries no such literals),
minus every `(name, version)` pair already in the round-1 index: 65
excluded, 136 pairs / 92 packages / 544 (package, version, hbcVersion) jobs
after dedup. `tools/pkgsig/bulk/continue-bulk.sh start` ran these under
`nohup` on `deb` (parallelism 12, reusing round 1's scaffolds/db/skip-logic
unchanged) and finished in ~14 minutes (most of the 544 candidates were
either already-built round-1 near-duplicates at other HBC versions, single
version-not-found `npm install` failures, or genuinely small packages) —
net +299 new `bulkBuildFixVersion: 1` signature files (32,355 → 32,654).

Two bugs found and fixed while measuring: (1) `candidates.mjs`'s `ssh deb
cat ~/...` command had its `~` expanded by the *local* shell before ssh
ever ran (unquoted), always failing — fixed by single-quoting the remote
command. (2) the first `continue-bulk.sh start` launch ran under `deb`'s
default `node` (v18, no `.ts` loader support — `ERR_UNKNOWN_FILE_EXTENSION`
on every job) instead of node 22 via `fnm`, per `docs/DEB-CI.md`'s own
warning; re-launched wrapped in `fnm exec --using 22 --`. Measurement also
found `deb`'s persistent `~/hbc2js` checkout was stale (`e49ab5b`, missing
the F2 by-instruction-weight metric and later match-precision work) —
updated to current `main` via `git fetch`/`git merge --ff-only` (careful:
`git stash -u` briefly moved the *live* `tools/pkgsig/bulk/` scripts round
2's own running jobs were reading from disk — round 2 had already finished
by the time this was needed, but a future agent doing this on a *live* run
should copy elsewhere first, not `stash -u` the directory in place).

Both runs below use `--no-shared-db --sigdb <dir>` (the repo's small
curated starter set disabled, isolating exactly what the bulk DB
contributes) against **the full round-1 db/ directory** (32,355 fixed
signature files), not the smaller `sigdb-20260830-fixed.tar.zst` archive
`fetch-db.sh` publishes (1,331 files — an early snapshot taken partway
through round 1's build, not its final state); this is why the "round 1"
numbers below don't match the `--no-shared-db`-free baseline used
elsewhere in this doc.

| | Service NSW (HBC96) round 1 | round 1+2 | rn-template-0.72 (HBC94) round 1 | round 1+2 |
|---|---|---|---|---|
| module-count attribution | 577/4510 (14.26%) | 666/4510 (15.90%) | 8/435 (1.84%) | 8/435 (1.84%) |
| **verified by instruction weight** | **64052/1435976 = 4.46%** | **69330/1435976 = 4.83%** | **566/92576 = 0.61%** | 566/92576 = 0.61% (unchanged) |
| distinct confirmed dependency names | 386 | 411 | 9 | 9 (unchanged) |

Service NSW moved (module count 14.26%→15.90%, +1.64pp; verified-by-weight
4.46%→4.83%, +0.37pp; confirmed names 386→411, +25) — round 2's
general-ecosystem candidates (redux, sha.js, events, ...) are exactly the
kind of code a real production app like Service NSW pulls in that a
round-1 list built mostly from `react-native`-adjacent packages missed.
rn-template-0.72 is unchanged (expected: round 2's candidates are RN
0.73.x-0.76.x-era and general npm packages, not RN-0.72-core-specific;
rn-template was already close to saturated by round 1's own targeted
build, and this table's `--no-shared-db` setting also removes the curated
starter DB that gets rn-template to 97.7% elsewhere in this doc). Neither
bundle is anywhere near 100% attribution yet — round 2's 92-package,
544-job candidate list is a small fraction of a real app's true dependency
tree (Service NSW alone has 4,510 modules); most of the remaining gap is
DB coverage (the exact npm versions Service NSW's bundler resolved,
unknown without `--confirm`/source maps), not a matching-algorithm limit.
See "Resume" below for extending this — the resume command reuses the same
`candidates.mjs`/`continue-bulk.sh` pair; a repeat run naturally makes
`candidates.mjs`'s round-1-index exclusion also skip round 2's own
now-built pairs, so the candidate list should be widened (more ecosystem
packages, more truth-fixture-derived pairs, additional `--nsw-json` string
evidence) before re-running rather than re-run unchanged against the same
list.

**Resume:** on `deb`, `cd ~/hbc2js && export PATH="$HOME/.local/share/fnm:$PATH"
&& fnm exec --using 22 -- bash tools/pkgsig/bulk/continue-bulk.sh status`
to check; extend `tools/pkgsig/bulk/candidates.mjs`'s `ECOSYSTEM_PACKAGES`
list or re-run it with a fresher `--nsw-json`, then `nohup fnm exec --using
22 -- bash tools/pkgsig/bulk/continue-bulk.sh start > ~/hbc2js-bulk/round2.out
2>&1 &` (must be `fnm exec`-wrapped — plain `nohup ... &` uses `deb`'s
default node 18 and fails every job with `ERR_UNKNOWN_FILE_EXTENSION`).

### D17f proof (2026-08-31)

D17f's claim (`docs/DECISIONS.md` D17f): if the signature DB carries an
app's real dependencies at their **exact** npm versions, `hbc2js deps`
recovers ~all of them. Proof-of-concept on
`tests/fixtures/bundles/react-navigation-example-0.85.3/` — the one app
fixture with both a real lockfile (exact versions) and D17d Metro
source-map ground truth (`deps-truth.json`). Scripts:
`tools/pkgsig/d17f-build-exact-db.mjs` (fingerprints candidates via
`src/deps/confirm.ts`'s `confirmCandidates` — the same single-package
builder `hbc2js deps --confirm` uses, reused as-is, not rewritten) and
`tools/pkgsig/d17f-score.mjs` (before/after via `tools/deps-truth.mjs`'s
`scoreAgainstTruth`, also reused as-is).

**Exact versions**, resolved from `react-navigation/react-navigation`'s
`pnpm-lock.yaml` at the fixture's pinned commit (non-workspace deps) and
from `deps-truth.json` itself (the `@react-navigation/*` + 2 sibling
packages, which resolve via the pnpm workspace straight to their own
`package.json`s — see that fixture's BUILD.md "workspace-package caveat"):
7 were already in the shared DB (`tools/pkgsig/db/`) at these exact
versions from earlier work (`react-native-gesture-handler@3.0.2`,
`-reanimated@4.5.3`, `-safe-area-context@5.7.0`, `-screens@4.26.2`,
`@react-native-async-storage/async-storage@2.2.0`,
`@react-navigation/{native@8.0.0-alpha.44,stack@8.0.0-alpha.53}`); 11 more
were fingerprinted fresh into a scratch DB for this task
(`react-native-worklets@0.11.3`, `@react-navigation/{core@8.0.0-alpha.34,
routers@8.0.0-alpha.17, elements@3.0.0-alpha.48, drawer@8.0.0-alpha.51,
devtools@8.0.0-alpha.35, bottom-tabs@8.0.0-alpha.50,
native-stack@8.0.0-alpha.52, material-top-tabs@8.0.0-alpha.49}`,
`react-native-drawer-layout@5.0.0-alpha.18`, `react-native-tab-view@5.0.0-
alpha.15`) — 18 exact-version packages total feeding the "after" DB.
10/11 of the fresh candidates fingerprinted and matched at medium/high tier
against this app's own bundle (`confirmCandidates` gates a write on that);
`@react-navigation/devtools` did not — its 0 exact-hash coverage is
consistent with it being dev-only tooling Metro strips from a release
build, not a pipeline failure.

**Gotcha found along the way**: bare `/tmp` is sandbox-restricted in the
agent environment this proof was built in such that `npm`/`npx react-native
bundle` subprocesses can silently fail to see files just installed there
(`Unable to resolve module <pkg>` immediately after a successful `npm
install` of that exact package) — not a `confirmCandidates` bug; the
scratch project must live under a genuinely-writable scratch directory
(this repo's agent scratchpad convention), not `/tmp` directly. Noted here
since it would otherwise look like flaky npm/Metro behaviour.

**Before → after** (`hbc2js deps --offline`, no `--confirm`; before =
shared starter DB only; after = + the 18-package exact-version scratch DB
layered via `--sigdb`), scored against the app's own `deps-truth.json` (75
total truth packages, 60 direct):

| | before (shared DB only) | after (+ exact-version DB) |
|---|---|---|
| confirmed packages (of 75 truth) | 9, recall 12.0% (15.0% of direct) | 16, recall 21.3% (21.7% of direct) |
| confirmed-tier false positives | 0 | 0 |
| **of the 18 exact-version-targeted packages specifically** | 7/18 confirmed (39%) | **14/18 confirmed (78%)** |
| per-module attribution (count) | 420/1547 correct (27.1%) | 410/1547 correct (26.5%) |
| per-module attribution (instr. weight) | 100012/292497 correct (34.2%) | 99484/292497 correct (34.0%) |

**Verdict: D17f is validated at the package-identification level, not (yet)
at the per-module-attribution level.** Exact-version fingerprinting took
this app's own targeted-dependency recall from 39% to 78% with zero new
false positives — strong, clean signal that "seed the DB from this app's
real versions" does what D17f claims for *whether a package is present*.
It did **not** move whole-bundle module/weight attribution, and nudged both
very slightly negative (27.1%→26.5%, 34.2%→34.0%) — inside noise, but
worth naming honestly rather than rounding to "unchanged": adding 10 new
`@react-navigation/*`-family signatures increases *sibling* hash collisions
(these packages genuinely share internal generated boilerplate — the same
cross-package-ambiguity mechanism `docs/PACKAGE-SIGNATURES.md` §6.7
documents for the 32,708-signature bulk DB, except that gate excludes a
hash only once ≥20 distinct packages claim it, calibrated for ecosystem-
wide collisions and not triggered by a ~10-package sibling family), so a
few modules that were previously (sometimes accidentally) attributed
correctly get reassigned to a related-but-wrong sibling once more siblings
are candidates. 4/18 targeted packages remained unconfirmed after
fingerprinting: 1 genuinely absent from the bundle (`devtools`, above) and
3 (`react-native-worklets`, `@react-navigation/routers`,
`react-native-tab-view`) that matched medium/high in isolation
(`confirmCandidates`' own single-candidate gate) but fell back below the
confirmed threshold once scored together with the other 17 signatures plus
the shared DB — the same sibling-collision dilution, not a fingerprinting
failure. Also observed, unrelated to this task's own DB work and not
investigated further (out of this task's file ownership): both before and
after report `@react-navigation/native`'s confirmed version as
`8.0.0-alpha.21` against a truth of `8.0.0-alpha.44` — the signature file
itself is the correct `.44` (`tools/pkgsig/db/@react-navigation__native@
8.0.0-alpha.44__hbc98.json`), so this looks like a version-string sourced
from elsewhere in the match/report path, not the DB entry; flagged for
whoever owns `src/deps/match.ts`/`report.ts` next.

**Reproduce**: `tests/fixtures/bundles/react-navigation-example-0.85.3/
fetch.sh` (regenerates the `.hbc` + `deps-truth.json`, not committed — see
that fixture's BUILD.md), then `node tools/pkgsig/d17f-build-exact-db.mjs
<scratchDir>` (repeat per-package with a 3rd arg if any candidate hits the
`/tmp`-sandbox gotcha above), copy the 7 already-shared-DB files it lists
into `<scratchDir>/sigdb/`, then `node tools/pkgsig/d17f-score.mjs
<scratchDir>`.

## Shared DB size

`tools/pkgsig/db` is ~16 MB as of this task (40 signature files + baselines,
`docs/PACKAGE-SIGNATURES.md` §5.3/§5.5) — comfortably under the ~40 MB
budget. If a single package's signature file grows unusually large (e.g. a
package that transitively re-includes a lot of code none of the three
foundation baselines cover, `docs/PACKAGE-SIGNATURES.md` §5.3's own
`@react-navigation/stack`@HBC98 example at 1.4 MB), note why in the commit
rather than silently letting the budget creep.

## Classification (D17h/D17j/D17i stage 2): library vs custom code, WITHOUT naming (2026-08-31)

Naming a dependency (package@version, everything above) is the hard, slow
problem — real recall depends on the signature DB having this exact
toolchain's builds. D17h ships a separate, easier capability: classify each
Metro module as third-party LIBRARY (ignorable) vs the app's OWN "custom"
code *without* naming the package at all. This is `src/deps/classify.ts`
(`classifyInventory`/`classifyModule`), wired additively into `runDeps`
(`DepsRunResult.classification`, `DepsReport.classification`, printed as a
headline line in `formatReportText`) — it does not touch match/guess/confirm
and can run even when the signature DB is empty.

**D17j (2026-08-31) reframed which signals are PRIMARY.** D17h's original
design leaned on cross-app recurrence against a multi-bundle "commonality
index" — real, but useless on a brand-new app the tool has never built an
index for, and (below) still weak even with one. D17j adds two signals
that work from evidence **inside a single bundle**, no corpus required, and
promotes them to primary; cross-app recurrence is kept as a bonus on top.

**Signals, in priority order:**

0. **Cross-app recurrence (bonus, D17h).** Per-*function* exact bytecode
   hash (the same hash `match.ts`'s signature DB uses, masking the Metro
   dependency-map index per `sig-normalise.ts`) looked up in a "commonality
   index" of hash -> count of DISTINCT contributing bundles, gated by a
   FLIRT-style `minInstr` floor (default 8). A module is library when a
   majority (default ≥50%) of its own instruction weight comes from
   functions whose hash recurs in ≥2 distinct bundles. Silent (never fires)
   on an empty/absent index — the normal state for a brand-new app.
1. **`node_modules`/bare package-path evidence (primary, D17j, strong).**
   A `node_modules/<pkg>/...` substring, or a bare (prefix-stripped)
   `<pkg>/lib|dist|src|.../*.js` package-relative path, in the module's own
   string constants (`libraryPathEvidence`, extracts the package name).
   `pkg@x.y.z`/`pkg vN.N.N`-shaped version-banner strings score the same
   tier (`package-name-version-string`). **Measured silent on both
   committed release fixtures** (`rn-template-0.72`,
   `react-navigation-example-0.85.3`) — Metro strips `node_modules/`-shaped
   require paths from optimised/release output, so this signal in practice
   fires mainly on `-g`/debug builds, source-mapped bundles, and libraries
   that self-embed a version banner (MetaMask's one big hit below).
2. **App-vocabulary presence (primary, D17j, the key idea).** The app's
   OWN vocabulary — derived straight from the bundle itself
   (`deriveAppVocabulary`), no cross-app corpus needed:
   - Any string independently recognisable as app-specific **by shape**,
     regardless of how often it recurs: a reverse-DNS/scoped bundle id
     (`com.example.myapp`), a `Screen`/`Route`/`Navigator`-suffixed
     identifier, an asset path, or a URL (the hostname itself is added to
     the vocabulary, not just the one concrete URL string, so a different
     path on the same host still matches).
   - Any other string that recurs across several distinct modules
     (≥3 by default) without being near-ubiquitous (≤15% of all modules) —
     the shape a shared route name, UI-copy constant, or API path prefix
     takes — **after** excluding generic JS/library boilerplate: known
     error-message shapes, and (the dominant real-world source of noise,
     found by measuring on `rn-template-0.72`) bare identifier-shaped
     tokens (`render`, `forwardRef`, `componentWillUnmount`, `__detach`,
     ...) and well-known JS/React/RN globals (`Array`, `Reflect`,
     `HermesInternal`, `Component`, ...) — these recur in nearly every
     module of nearly every bundle because they're common surface, not
     because they say anything about one particular app.
   A module whose strings hit the vocabulary is CUSTOM.
3. **Structural shape (D17j, weakest, last-checked).** ≥2 functions,
   ≤75 avg instructions/function — only consulted once app-vocabulary has
   already been ruled out for the module, so every one of its strings is
   already known not to be app-specific/vocabulary. (An earlier version
   also capped the module's raw string *count* at ≤2 on the theory that
   library modules have few strings; measured false on real bundles —
   median 16 string constants per module even in pure react-native runtime
   code — and dropped: string *content*, already vetted above, is the
   signal, not string count.)

**Combination rule:** a module is **LIBRARY** if node_modules-evidence OR
(no app-vocab AND generic structural shape); **CUSTOM** if app-vocab is
present; else **UNKNOWN** — doubt is reported honestly rather than defaulted
either way, now that app-vocabulary gives a real positive way to decide
CUSTOM. (D17h's original design defaulted "no signal" to `app`; D17j
replaces that default with `unknown` since a real positive CUSTOM signal
now exists.) Each classification also carries a `confidence` (0..1, string
evidence ~0.85-0.95, app-vocabulary scaled by how many distinct tokens
matched, structural-shape ~0.35) and a `libraryPackageHint` (the package
name extracted from node_modules/version-banner evidence, when present —
a hint only, not run through `guess.ts`/`match.ts` naming/confirmation).

**Commonality index** (`tools/pkgsig/commonality-index.json`, regenerated by
`tools/pkgsig/build-commonality-index.mjs`): hash + distinct-bundle-count
only, never bundle content or a bundle identifier — safe to commit (D16).
Built from one bundle per distinct app: the two committed open-source C3
fixtures (`rn-template-0.72`, `react-navigation-example-0.85.3`, debug/
`noopt`/`truth` build-variant copies of the same app deliberately excluded
so they don't inflate "cross-app" recurrence) plus whatever's present under
`tests/fixtures/local-corpus/*/bundle.hbc` (D16 C5, gitignored, extracted
via `tools/extract-apk-bundle.sh`). Current committed index: **5 bundles**
(2 open-source + MetaMask/Brex/Discord, HBC 94/96/98/98/98),  248,283
distinct eligible function hashes, 3,193 recurring in ≥2 — 7.2 MB.

**Measured (2026-08-31): library-vs-custom % by weight, WITHOUT any
cross-app corpus** (`classifyInventory(inventory, EMPTY_COMMONALITY_INDEX)`
— i.e. D17j's primary signals alone, exactly what a brand-new app with no
commonality index gets on first run), vs. the OLD D17h recurrence-primary
number (5-bundle corpus) and naming's own `percentVerifiedByWeight`:

| Bundle | HBC | naming verified-by-weight | OLD classify (5-bundle corpus) | **NEW classify, corpus-free** |
|---|---|---|---|---|
| `rn-template-0.72` | 94 | 98.6% | 1.2% | **41.1%** |
| `react-navigation-example-0.85.3` | 98 | 59.8% | 1.7% | **26.5%** |
| local-corpus MetaMask | 96 | 0.5% | 19.7% | **39.5%** |
| local-corpus Brex | 98 | 0.3% | 0.5% | **25.1%** |
| local-corpus Discord | 98 | 0.2% | 0.2% | **13.6%** |

Every bundle moved up substantially, corpus-free — MetaMask alone (the
D17j acceptance target) roughly **doubled**, 19.7% → 39.5%, with zero
cross-app corpus involved (the old 19.7% needed a 5-bundle index; the new
39.5% needs none). `rn-template`'s jump (1.2% → 41.1%) is almost entirely
`structural-shape` (38,008 of its ~92k total instructions) — app-vocabulary
correctly stayed silent on library modules once the bare-identifier/known-
global exclusions above were added (before that fix, an earlier iteration
of app-vocabulary measured 90%+ **custom** on this bundle, i.e. it was
calling most of react-native's own runtime "custom" — a real false-positive
finding from measuring on a real bundle, not a hypothetical, fixed by
tightening `isGenericBoilerplate` rather than by loosening the signal's
reach).

**Honest false-positive-risk read.** `rn-template` is ~98.6%-library by
naming ground truth, so its measured 41.1%-library / ~53%-custom split
means roughly half the bundle is still library code labelled CUSTOM by this
signal set — the residual, known cause is `SCREEN_OR_ROUTE_RE`
(`Screen`/`Route`/`Navigator`-suffixed identifiers): real for an app's own
screen components, but react-navigation's *own internal* type/prop names
use the identical shape (`StackNavigator`, `NavigationRoute`, ...), so a
navigation-heavy bundle's own library code gets mistaken for app vocabulary
by the very heuristic meant to find it. This is the direction D17h always
considered safe to be wrong in (library code showing up as "custom" only
means an analyst reviews a bit more code, never that real app code goes
missing) — the reverse (real app code called LIBRARY) risks silently
hiding something real, and neither node_modules-path nor structural-shape
can ever fire on a module app-vocabulary already claimed, by construction
of the combination rule — but it does mean the corpus-free "% library"
number above should be read as a **floor**, not a ceiling: real
library-vs-custom precision needs either the bonus cross-app-recurrence
signal (which subsumes this case correctly since react-navigation's own
code, being byte-identical across the apps that ship it, recurs) or a
tighter app-vocabulary/screen-name heuristic — noted here rather than
chased further under this task's time box.

**Stage 3** (naming the classified-library modules, D17i point 3) can now
scope its work to exactly the modules this stage marks `library` — the
`guess`/`confirm` machinery already exists (`src/deps/guess.ts`/
`confirm.ts`); what it needs next is to be pointed at
`classification.modules.filter(m => m.classification === "library")`
instead of match's `unattributedModules`.

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
- `tests/gate/deps/classify.test.ts` — D17h/D17j/D17i stage 2
  classification (27 tests): each signal in isolation (recurrence
  at/above/below threshold, minInstr floor, majority-of-weight fraction
  gate, node_modules-path + package-name extraction incl. scoped packages,
  bare package-relative path incl. its own route-path false-positive
  guard, package-name-version-string, `deriveAppVocabulary`'s
  frequency-window and shape-distinctive inclusion and generic-boilerplate
  exclusion, structural-shape + app-vocabulary preempting it, node_modules
  evidence winning over a vocabulary coincidence, the custom/unknown
  defaults), `buildCommonalityIndex`/`mergeCommonalityIndexes`'s
  distinct-bundle counting, and three integration checks against the real
  `rn-template-0.72` fixture (a self-built commonality index recovers its
  own eligible functions; the real committed
  `tools/pkgsig/commonality-index.json` produces a well-formed report,
  skipped gracefully if that file is ever absent from a checkout; a fully
  corpus-free run — `EMPTY_COMMONALITY_INDEX` — still derives a non-empty
  app vocabulary and classifies every module, D17j's own claim).
- `tests/sweep/deps/corpus.test.ts` — the seed-run corpus, skipped
  (INCONCLUSIVE) when its inputs are absent.
- `tests/sweep/deps/truth-react-navigation.test.ts` — D17d on
  react-navigation-example, skipped until its map/truth are generated.
- `tests/sweep/deps/confirm-react-navigation.test.ts` — `--confirm` against
  react-navigation-example with a real npm registry, `--no-shared-db`;
  skipped (INCONCLUSIVE) without the sweep tier or the fixture's
  `.hbc`/`deps-truth.json`. Numbers: "`--confirm` precision/recall" above.
