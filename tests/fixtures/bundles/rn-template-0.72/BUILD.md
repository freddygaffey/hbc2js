# rn-template-0.72 — build provenance

Tier 2 (D3 round-trip recompilation) fixture per `docs/TEST-CORPUS.md` §2
table row 1 ("Fresh `npx react-native@latest init` template" — pinned here to
the 0.72.x line so the bytecode version matches this repo's HBC 94 tooling).
This is the first, cheapest Tier 2 fixture: no external repo, no secrets, no
native build, just Metro + `hermesc`.

## Environment this was built in

- macOS (Darwin arm64), Node v25.9.0, npm 11.12.1
- Built entirely in a scratch directory *outside* this repo, per instructions;
  only the JS bundle and compiled `.hbc` files were copied in.

## Exact commands

```sh
# 1. Scaffold, pinned to RN 0.72.17 (-> HBC bytecode version 94, matching
#    tools/get-hermesc.sh 94 / react-native@0.72.17's own bundled hermesc).
npx --yes react-native@0.72.17 init HelloHermes072 --version 0.72.17 --skip-install --npm
cd HelloHermes072

# 2. Install dependencies (892 packages, ~29s; several deprecation warnings
#    from old transitive deps, no install-time errors despite the very new
#    Node 25 runtime vs. this old RN release's package.json engines: >=16).
npm install

# 3. Produce a release-mode Android JS bundle via Metro (unmodified stock
#    template source, no code changes).
npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output ./index.android.bundle \
  --assets-dest ./release-assets \
  --minify true \
  --reset-cache
# -> index.android.bundle, 820822 bytes (see docs/TEST-CORPUS.md's estimate
#    of "~0.5-1.5 MB unminified" for this fixture -- ours is the --minify
#    true, --dev false release bundle, smaller than that estimate's
#    unminified case).

# 4. Compile to Hermes bytecode with hermesc v94 (this repo's
#    tools/hermesc/v94/hermesc, itself sourced from react-native@0.72.17 --
#    confirmed byte-identical hermesc binary to the one bundled inside
#    node_modules/react-native/sdks/hermesc/osx-bin/hermesc for this same
#    scaffolded project; both report "HBC bytecode version: 94").
HERMESC=/path/to/tools/hermesc/v94/hermesc

$HERMESC -emit-binary -out=index.android.hbc            index.android.bundle   # default flags
$HERMESC -O -emit-binary -out=index.android.O.hbc        index.android.bundle   # explicit -O
$HERMESC -O0 -emit-binary -out=index.android.noopt.hbc   index.android.bundle
$HERMESC -g -emit-binary -out=index.android.debug.hbc          index.android.bundle
$HERMESC -O -g -emit-binary -out=index.android.Og.hbc          index.android.bundle
$HERMESC -O0 -g -emit-binary -out=index.android.noopt.debug.hbc index.android.bundle
```

## `truth/` — the D17d ground-truth rebuild (2026-08-30)

`truth/index.android.hbc`, `truth/index.android.debug.hbc` and
`truth/deps-truth.json` come from a *second* run of steps 1-4 (same commands,
Node v25.9.0, npm 11.12.1) with Metro's source map added to step 3:

```sh
npx react-native bundle --platform android --dev false --entry-file index.js   --bundle-output ./index.android.bundle --sourcemap-output ./index.android.map   --assets-dest ./release-assets --minify true --reset-cache
$HERMESC -O    -emit-binary -out=index.android.hbc       index.android.bundle
$HERMESC -O -g -emit-binary -out=index.android.debug.hbc index.android.bundle
# in the repo root, with the scaffold still on disk (package.json versions
# and the app's own package.json are read from it):
node tools/deps-truth.mjs <scaffold>/index.android.hbc <scaffold>/index.android.map   --bundle-js <scaffold>/index.android.bundle --also-hbc <scaffold>/index.android.debug.hbc   --write-truth tests/fixtures/bundles/rn-template-0.72/truth/deps-truth.json
```

The rebuilt bundle is *not* byte-identical to the top-level one (transitive
package versions float: e.g. `@babel/runtime` 7.29.7 in this rebuild), so the
truth file only describes the `.hbc` files under `truth/` — it records their
sha256s and the scoring tool warns on a mismatch. The 3.6 MB map and the
bundle are not committed; the truth file (~70 KB) is what the gate test
`tests/gate/deps/truth.test.ts` reads. Direct dependencies per the
scaffold's package.json: `react@18.2.0`, `react-native@0.72.17`; 18 further
packages appear transitively (see `deps-truth.json` → `transitiveOf`).

## Finding: `-O` is this hermesc build's *default*, not an opt-in

Compiling with no flags at all produced a file **byte-identical** to compiling
with explicit `-O` (`cmp` exit 0). Likewise `-g` alone was byte-identical to
`-O -g`. The only way to get a genuinely *different*, non-optimized bytecode
was the explicit disabling flag `-O0` (confirmed via `hermesc --help`:
`-O - Expensive optimizations` is listed as a flag you can pass, but the
compiler evidently already applies it unless `-O0` is given). So "with and
without `-O`" for this hermesc build is actually "default/`-O` vs. `-O0`",
not "no flag vs. `-O`" — both of the latter are the same thing. This is worth
knowing for anyone writing a decompiler test matrix that assumes "no `-O`
flag" means "unoptimized bytecode": for react-native@0.72.17's bundled
hermesc, it does not.

## Files kept in this directory and their exact provenance

| File | Command | Size (bytes) |
|---|---|---|
| `index.android.bundle` | step 3 above (Metro, `--dev false --minify true`) | 820,822 |
| `index.android.hbc` | `hermesc -O -emit-binary` (== default, no flags) | 1,232,481 |
| `index.android.noopt.hbc` | `hermesc -O0 -emit-binary` | 1,784,252 |
| `index.android.debug.hbc` | `hermesc -O -g -emit-binary` (== `-g` alone) | 1,822,763 |
| `index.android.noopt.debug.hbc` | `hermesc -O0 -g -emit-binary` | 2,742,411 |

Total fixture size: ~8.0 MB. All four `.hbc` variants are individually well
under the 5 MB "keep only the plain `-O` variant" threshold from this task's
instructions, so all four were kept rather than trimmed. `hermesc --version`
on the compiler used: `Hermes release version: for RN 0.72.17`, `HBC bytecode
version: 94`.

## Regenerating

Re-run the four commands in "Exact commands" step 4 against a freshly
regenerated `index.android.bundle` (steps 1-3) if the fixture ever needs to be
rebuilt — nothing here depends on machine-specific paths (the bundle records
no absolute paths; `hermesc`'s debug info records source-map-relative names
from the bundle's own `//# sourceMappingURL=` / module ID comments, not the
scaffold directory path).

## What this fixture is for (D3)

Real RN bundles can't run under Node's `vm` sandbox (D2) — they reference
`__d`/`require`/native-module globals that don't exist outside a Hermes/RN
host. Per `docs/DECISIONS.md` D3, correctness for this tier is checked via
round-trip recompilation: decompile `index.android.hbc` -> recompile with
`hermesc` -> disassemble both -> structural diff (register/label names
normalised). This fixture is the cheapest possible instance of that: a real,
if minimal, Metro-bundled app (React Native's own default template — the
`Hello, World`-equivalent screen plus the RN core JS runtime it pulls in:
`react`, the RN renderer, the module registry, polyfills), not a hand-written
Tier 1 construct.
