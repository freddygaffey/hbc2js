# tools/pkgsig — package-signature pipeline (T8, v2)

Turns the T8 feasibility prototype (`docs/PACKAGE-SIGNATURES.md` §1–§4) into
a working signature-database pipeline: bundle → compile → fingerprint → match,
end to end. Node ESM, zero dependencies beyond this repo's own `src/**`
(parser/disassembler only, imported directly via Node's native TypeScript
support — no build step) plus Node's own `child_process`/`crypto`/`fs`. Not
wired into the CLI or test suite; this is still a standalone tool, not the
D17 pass itself (see `docs/PACKAGE-SIGNATURES.md` §5.7 for what D17 needs
from here).

No `src/**` files are written or modified by anything under `tools/pkgsig/`
— everything here only *imports* the existing parser (`src/index.ts`),
disassembler (`src/disasm/decode.ts`), and literal-buffer reader
(`src/parse/buffers.ts`). The one place this task needed a normaliser change
(masking a require-call-site immediate, `docs/PACKAGE-SIGNATURES.md` §5.1)
is implemented as `lib/sig-normalise.mjs`, a **fork** of
`src/harness/roundtrip.ts`'s `normaliseFunction` — not an edit to it, since
that oracle must stay byte-exact for D3's round-trip diffing. §5.7 of the
docs describes what would need to change in `src/**` if the M4 decompiler
agent wants to adopt this fix there too.

## Layout

```
tools/pkgsig/
  build-db.mjs          end-to-end: bundle -> compile -> fingerprint -> tools/pkgsig/db/
  build-signatures.mjs  low-level: fingerprint an already-compiled .hbc directly
  match.mjs             match a target .hbc against every DB under tools/pkgsig/db/
  lib/
    sig-normalise.mjs   pkgsig-local normaliser fork + require-immediate masking
    dscan.mjs           Metro __d(factory, id, deps) module-graph recovery
    fingerprint.mjs      per-function tiers + per-module fingerprint, shared by
                         build-db.mjs and build-signatures.mjs
  db/
    index.json           flat manifest of every signature file
    <pkg>@<ver>__hbc<N>.json     one per package x HBC version (schema 2, see below)
    _baselines/
      metro-toolchain-empty@<metro-ver>__hbc<N>.json
      react-foundation@<react-ver>__hbc<N>.json
      react-native-foundation@<rn-ver>__hbc<N>.json
```

## Signature DB format (schema 2)

See `docs/PACKAGE-SIGNATURES.md` §5.3 for the full annotated example and
rationale. In brief, per `package@version` × HBC version:

- **`functions`**: per Hermes function, `exactHash` (masked-canonical-form
  sha256, §5.1), `fuzzyHash` (bare mnemonic sequence sha256), `stringSetHash`
  + `stringCount` (hash of the sorted string-literal set, not the raw
  array — kept compact per the "hashes and metadata, not code" requirement).
  All hashes truncated to 24 hex chars (96 bits).
- **`modules`**: one entry per `__d()` registration recovered by
  `dscan.mjs` — factory function index, local module id, dependency-id
  array, the factory's own hash pair, and a nested-closure count/hash.
- **`totalFunctions`** is the *post-baseline-subtraction* count;
  `rawFunctionCount` keeps the pre-subtraction count for transparency, and
  `subtractedBaselines` names which baseline files were subtracted.
- **`provenance`**: package content hash (`packageSha256` — sha256 over a
  sorted manifest of `node_modules/<pkg>`'s own files, *not* a registry
  tarball hash), Metro/RN/hermesc versions, this repo's own commit, build
  timestamp.

## `build-db.mjs` — end-to-end pipeline

```sh
node --experimental-strip-types tools/pkgsig/build-db.mjs <pkg>@<ver> \
  --project <dir-with-node_modules-already-installed> \
  [--hbc 94|96|98|99] [--subtract <baseline1.json>,<baseline2.json>,...] \
  [--out tools/pkgsig/db]
```

Writes a `require('<pkg>')` entry file into `--project`, bundles it with
`npx react-native bundle --platform android --dev false --minify true`,
compiles with `tools/hermesc/v<N>/hermesc -O`, fingerprints the result, and
writes it into `--out` plus updates `index.json`. If the package isn't yet
installed at the requested version in `--project`, this runs `npm install
<pkg>@<ver> --legacy-peer-deps` there first (real network access —
intentional, matches every other Tier-2 fixture in this repo).

`--project` is expected to already have `react-native` (and whatever else
the target package needs) installed at the version whose `hermesc` you're
targeting — this script does not scaffold a fresh RN template itself;
`tests/fixtures/bundles/*/BUILD.md` have the reference scaffolding recipes
(RN-CLI path). For an **Expo**-bundled toolchain (needed for HBC98 in this
task, since `react-native bundle` doesn't work standalone inside the
`react-navigation/react-navigation` example's pnpm workspace — no
`@react-native-community/cli` there), `--bundler expo` is deliberately
**not** automated in this prototype: `expo export` has no custom-entry-file
flag, so each single-package HBC98 fingerprint in this task's DB was
produced by temporarily overwriting the cloned example app's `App.tsx` with
a one-line `require('<pkg>')` re-export, `expo export --no-bytecode`,
restoring `App.tsx`, then feeding the resulting JS text to `build-db.mjs
--hbc-file` (skipping the bundling step, just fingerprinting + provenance).
See `docs/PACKAGE-SIGNATURES.md` §5.5 for the exact recipe.

### Baselining a new (RN, Hermes, bundler) toolchain

`docs/PACKAGE-SIGNATURES.md` §5.2 has the full rationale; in short:

```sh
# 1. Toolchain-empty baseline (module.exports = {}; entry).
node --experimental-strip-types tools/pkgsig/build-db.mjs metro-toolchain-empty@<metro-ver> \
  --project <dir> --hbc <N> --baseline metro-toolchain-empty

# 2/3. react and react-native foundations.
node --experimental-strip-types tools/pkgsig/build-db.mjs react@<ver> --project <dir> --hbc <N> --baseline react-foundation
node --experimental-strip-types tools/pkgsig/build-db.mjs react-native@<ver> --project <dir> --hbc <N> --baseline react-native-foundation

# 4. Every other package for that toolchain subtracts all three.
node --experimental-strip-types tools/pkgsig/build-db.mjs <pkg>@<ver> --project <dir> --hbc <N> \
  --subtract tools/pkgsig/db/_baselines/metro-toolchain-empty@<metro-ver>__hbc<N>.json,tools/pkgsig/db/_baselines/react-foundation@<ver>__hbc<N>.json,tools/pkgsig/db/_baselines/react-native-foundation@<ver>__hbc<N>.json
```

**A baseline is specific to the bundler, not just the RN/Hermes version
pair** — this task found Expo's own empty-entry baseline is 414 functions at
HBC98 vs. plain RN-CLI's 75 at HBC94/96 (same general Hermes bytecode era,
very different bundler-injected runtime weight). Don't reuse one bundler's
baseline for another's output.

## `build-signatures.mjs` — low-level fingerprinter

```sh
node --experimental-strip-types tools/pkgsig/build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json> [--baseline]
```

Fingerprints an already-compiled `.hbc` directly, no bundling. Used
internally by `build-db.mjs`'s `--hbc-file` fast path, and useful standalone
when you already have a `.hbc` (e.g. a fixture, or hand-built).

## `match.mjs` — matching

```sh
node --experimental-strip-types tools/pkgsig/match.mjs <bundle.hbc> --db tools/pkgsig/db [--min-instr N] [--json]
```

Reports, per HBC-version-eligible package DB (baselines included): exact/fuzzy
function coverage, module-exact-hit count, and a confidence tier (High/Medium/
Low/None — see `docs/PACKAGE-SIGNATURES.md` §5.4 for the exact thresholds and
why they require *several* independent module hits, not just one, before
calling a package "High" confidence). Also reports **per-Metro-module
attribution**: every `__d()`-registered module in the target, best-owning
package by factory-hash lookup, and the largest **unmatched** modules
(instruction count as a size proxy) — this is where genuine first-party app
code should surface.

Baseline subtraction already happened once, at DB-build time
(`build-db.mjs --subtract`) — `match.mjs` v2 has no `--baseline` flag of its
own; every package DB under `tools/pkgsig/db/` (not `db/_baselines/`) already
has toolchain/react/react-native noise subtracted out.

`--min-instr N` excludes functions shorter than N instructions from every
rate (a FLIRT-style minimum-length floor — `docs/PACKAGE-SIGNATURES.md` §2.4
used 8; that's also `match.mjs`'s default).

## Reproducing this task's measurements

See `docs/PACKAGE-SIGNATURES.md` §5.5/§5.6 for the exact recipes (starter-set
DB construction, and matching against `rn-template-0.72`,
`react-navigation-example-0.85.3`, Expensify/App, and the
`~/hbc2js-local-corpus` APKs). Everything runs in scratch, outside this
repo — no npm installs, third-party bundles, or extracted APK contents are
committed here, only the compact signature JSON files under `tools/pkgsig/db/`.

## Known limitations (see `docs/PACKAGE-SIGNATURES.md` §5.8 for the full list)

- The require-immediate masking fix (§5.1) is implemented and measurably
  helps, but is **not** the dominant cause of `react`'s remaining
  function-level exact-match gap against a real app bundle — that root
  cause is still open. Whole-module anchoring (module-exact-hash matching,
  via `dscan.mjs`) already routes around this for every case measured here.
- HBC98 starter-set coverage is partial: 10/16 packages (the
  `@react-navigation`/gesture-handler/reanimated/screens/safe-area/
  async-storage cluster, fetched from `react-navigation-example`'s own
  resolved `node_modules`); redux/axios/lodash/moment/dayjs/zustand/immer
  exist only at HBC94/96 so far.
- Version-ambiguity (two candidate versions sharing every matched hash) is
  unmeasured — no fixture or corpus app in this task exercised it.
