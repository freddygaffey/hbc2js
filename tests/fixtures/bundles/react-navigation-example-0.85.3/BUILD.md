# react-navigation example app — Tier 2 / C3 fixture

Source: `react-navigation/react-navigation`, `example/` (MIT). Commit
`ab1319d6bbf05eae8dc25e33cbf4dc56494e0f0c` (2026-08-26, shallow-cloned
2026-08-30). `react-native` = **0.85.3** (verified `example/package.json`),
`react-native` depends on `hermes-compiler@250829098.0.10` → **HBC bytecode
version 98**. `tools/get-hermesc.sh` was extended with a `98` entry
(`hermes-compiler@250829098.0.10`, same `package/hermesc/OSDIR_TOKEN` layout
as the existing 99 entry) to fetch a matching compiler.

The bundle/`.hbc` files are **not committed** — the JS bundle is 3.5 MB and
the `-O` `.hbc` is 4.3 MB, both over the 3 MB commit threshold. Run
`fetch.sh` to regenerate them locally; sha256 + sizes below let you verify
the regenerated artifacts match what this report was written against.

## Reproducing

```sh
git clone --depth 1 https://github.com/react-navigation/react-navigation.git rn-nav
cd rn-nav
git rev-parse HEAD   # expect ab1319d6bbf05eae8dc25e33cbf4dc56494e0f0c (or later — repo moves; pin with a real clone+checkout if exact match matters)

# workspace install (pnpm, monorepo root) — took ~18s, no native build, no secrets
pnpm install --frozen-lockfile

cd example
# Expo app: `expo export` invokes Metro + hermesc internally. Pass --no-bytecode
# to keep the raw JS text bundle instead of (or in addition to) the .hbc, and
# --source-maps so Metro emits a source map alongside it (D17d ground truth —
# docs/DECISIONS.md D17d, docs/DEPS.md "Ground truth"): each `__d(...)` line's
# source path, via the map, tells you the npm package (and, from that
# package's own package.json next to it in node_modules, its exact version)
# that module came from.
node_modules/.bin/expo export --platform android --output-dir dist-js --no-bytecode --source-maps
node_modules/.bin/expo export --platform android --output-dir dist-hbc
# JS bundle lands at dist-js/_expo/static/js/android/App-<hash>.js, its
# source map at dist-js/_expo/static/js/android/App-<hash>.map (Expo's own
# .hbc, for cross-check, at dist-hbc/_expo/static/js/android/App-<hash>.hbc).

# Compile the JS bundle ourselves with the matching HBC-98 hermesc, recording
# both a release (-O) and debug (-O -g) variant:
../../../tools/get-hermesc.sh 98
HERMESC=../../../tools/hermesc/v98/hermesc
cp dist-js/_expo/static/js/android/App-*.js index.android.bundle
$HERMESC -O -emit-binary -out=react-navigation-example.hbc index.android.bundle
$HERMESC -O -g -emit-binary -out=react-navigation-example.debug.hbc index.android.bundle

# Derive the truth file straight from the map, while node_modules is still on
# disk (run this from `example/`, against the *original* dist-js/.js + .map,
# not the copies above, so the map's relative `sources` entries resolve):
node ../../../../tools/deps-truth.mjs react-navigation-example.hbc \
  dist-js/_expo/static/js/android/App-*.map \
  --bundle-js dist-js/_expo/static/js/android/App-*.js \
  --write-truth deps-truth.json \
  --also-hbc react-navigation-example.debug.hbc \
  --root ../..   # the rn-nav workspace root — see note below
```

Or just run `./fetch.sh` in this directory, which does the above end to end
(including the truth derivation).

## Ground truth (D17d)

`fetch.sh` also writes `react-navigation-example.map` (the Metro source map)
and `deps-truth.json` (the compact module-id -> package@version truth derived
from it, `tools/deps-truth.mjs`) alongside the bundle. Like the bundle/`.hbc`
files, **neither is committed** (the map is several MB; `deps-truth.json` is
small but is a build artefact like the rest of this fixture's regenerable
files) — run `fetch.sh` to get them locally.  `tests/sweep/deps/truth-react-navigation.test.ts`
scores `hbc2js deps` against `deps-truth.json` (skips, INCONCLUSIVE, until
it exists).

**Workspace-package caveat.** This app is `react-navigation/react-navigation`'s
own `example/`, so `@react-navigation/{native,stack,core,routers,elements,
drawer,bottom-tabs,devtools,...}` resolve via the pnpm workspace straight to
that monorepo's own `packages/<name>/src/...` sources, never through
`node_modules/<pkg>/...` — Metro's source map records e.g.
`/packages/native/src/index.tsx`. `tools/deps-truth.mjs`'s `packageFromSource`
only recognises `node_modules/`, so without help every one of those modules'
truth would come back `package: null` (counted as "app code"), and a real,
correct `@react-navigation/native`/`stack` detection from `hbc2js deps` would
score as a **false positive** instead of a true positive. `fetch.sh` passes
`--root "$WORK/rn-nav"` (the cloned workspace root, still on disk at that
point) so `truthFromMap`'s `packageFromWorkspaceSource` fallback can resolve
`/packages/<name>/` sources to that package's own `package.json` (`name` +
`version`) the same way `node_modules/` ones resolve — generic to any
npm/yarn/pnpm/lerna workspace using the common `packages/<name>` layout, not
special-cased to this repo. Only active when `--root` is passed (fixture
generation time); scoring a committed `truth.json` never needs it.

## Sizes, timing, hashes

| Artifact | Size | sha256 |
|---|---|---|
| `index.android.bundle` (JS, minified, `--no-bytecode` export) | 3,525,764 bytes (3.36 MB) | `07b00f6da27e57ba54a7d53263036504fbd8c26566b04bd43a9072712f407a21` |
| `react-navigation-example.hbc` (`-O`, our hermesc v98) | 4,517,682 bytes (4.31 MB) | `a8a42a7037645ee963178522cda078f0a74617a007550a20314b6b0e87803c09` |
| `react-navigation-example.debug.hbc` (`-O -g`, our hermesc v98) | 5,429,268 bytes (5.18 MB) | `145ae44ca8105fa3bc59df572f60b4e602afe44fa0cd1b5686640d72b6d216fb` |
| Expo's own `.hbc` (`expo export` default, no `--no-bytecode`) | 4,546,018 bytes (4.34 MB) | not recorded — used only as a sanity cross-check that our standalone `hermesc -O` invocation (4,517,682 bytes) is in the same ballpark as Expo's internal one (4,546,018 bytes); the small delta is expected (Expo's Metro/hermesc integration may pass slightly different flags than a bare CLI `-O -emit-binary` call) |

Compile time (Apple Silicon, `tools/hermesc/v98/hermesc`, single run, `time`):
- `-O`: **2.606s total** (2.54s user)
- `-O -g`: **2.751s total** (2.69s user)

## Verification

- `hbc-file-parser react-navigation-example.hbc` parses cleanly (prints a
  "development/recent version, not formally supported" warning for v98 like
  it does for v99, per `docs/TOOLCHAIN.md`, but the header dump is
  self-consistent and matches `hermesc`'s own `--version` output: magic
  `c61fbc03c103191f`, version 98).
- `hermesc -dump-bytecode` on the source bundle ran to completion (~940k
  lines of disassembly text; many `-O` warnings about undeclared globals in
  anonymous IIFEs — expected, these are Metro's polyfill/require wrappers
  referencing `require`/`Promise`/`alert` as free variables that Hermes can't
  statically resolve without the RN host globals present, harmless).

Header fields of note (`hbc-file-parser`):

| Field | Value |
|---|---|
| FunctionCount | 15,551 |
| IdentifierCount | 17,010 |
| StringCount | 0x8afe (35,582) |
| OverflowStringCount | 345 |
| RegExpCount | 152 |
| ObjShapeTableCount | 2,935 |
| NumStringSwitchImms | 10 |
| CjsModuleCount | 0 |
| FunctionSourceCount | 50 |
| HasAsync | 0 |

## Decompilation-relevant characteristics

- **Metro module wrapper**: standard `__d(function(g,r,i,a,m,e,d){...}, <id>, [<dep ids>])`
  present throughout (confirmed by grepping the raw bundle) — same shape as
  every other Metro-bundled RN app; module IDs are numeric, not string paths
  (production/`--dev false` numbering).
- **`require` polyfill**: present as the usual Metro `require`/`__d`/`__r`
  trio at the top of the bundle; `$$require_external` shim is also present
  (Expo-specific — throws for any Node-stdlib-style import that isn't
  actually available at runtime, guards a few conditional `require(...)`
  calls that only resolve on `expo`/web).
- **Inline requires**: yes — `require`/`_r(_d[n])` calls appear inline
  inside function bodies throughout (typical of Metro's `inlineRequires`
  transform, on by default for RN release builds), not hoisted to the top of
  each module.
- **Classes**: Babel-transformed away — no `class` bytecode-level construct
  expected (this bundle's Hermes is v98/Static-Hermes-era and *can* compile
  native classes per `docs/TOOLCHAIN.md`/`tests/fixtures/README.md`, but
  Expo's default Babel preset still lowers TS/JSX classes to function+
  prototype form before Hermes ever sees them for this RN version — not
  independently re-verified by grepping for a `Class` opcode in the dump,
  flagging as an assumption to double check if class-recovery work needs a
  real bytecode-classes bundle).
- **Generators**: `CreateGenerator` appears **73 times** in the
  `-dump-bytecode` output — real opcode-driven generators are still emitted
  at HBC 98 (not lowered to the D9 "compiler state machine" form that
  motivated the `__hbc_makeGenerator` shim; that finding may be
  version/optimization-level specific and worth re-checking against other
  v98+ bundles).
- **Async**: header `HasAsync: 0`, and no `CreateAsyncClosure`-style opcode
  was found in the dump — this bundle's `async`/`await` usage compiles
  through the generator+promise-glue path (`CreateGenerator` covers it) or
  simply doesn't hit whatever code path sets `HasAsync`; not fully resolved,
  flagging for follow-up rather than asserting a firm conclusion.
- **Switch jump tables**: `UIntSwitchImm` × 26, `StringSwitchImm` × 10 (36
  total jump-table instructions) — confirms real-world Metro/RN bundles do
  produce both integer and string switch jump tables (Tier 1 fixtures 52/53
  only exercise the integer case synthetically; this is corroborating
  real-world evidence the string case matters too).
