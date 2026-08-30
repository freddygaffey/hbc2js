# tools/pkgsig — package-signature feasibility prototype (T8)

Prototype scripts for `docs/PACKAGE-SIGNATURES.md` §2. Node ESM, zero
dependencies beyond this repo's own `src/**` (imported directly via Node's
native TypeScript support — no build step). Not wired into the CLI or test
suite; this is a research prototype, not the D17 pass itself.

No `src/**` files were written or modified to produce this — both scripts
only *import* the existing parser (`src/index.ts`), disassembler
(`src/disasm/decode.ts`), and D3 round-trip normaliser
(`src/harness/roundtrip.ts`).

## Scripts

### `build-signatures.mjs`

Fingerprints every function in a compiled `.hbc` file into a signature
database (JSON). Three tiers per function — see the file's header comment
and `docs/PACKAGE-SIGNATURES.md` §2.2 for the full rationale:

- `exactHash` — sha256 of `normaliseFunction`'s output (registers/cache
  slots/names normalised, literal content kept).
- `fuzzyHash` — sha256 of the bare mnemonic sequence, all operands stripped.
- `stringSet` — sorted string-literal operands (secondary Jaccard signal).

```sh
node --experimental-strip-types build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json>
```

(`--experimental-strip-types` is needed because this script dynamically
imports `.ts` files from `src/**`; `match.mjs` below needs no such flag since
it only reads the JSON output.)

### `match.mjs`

Matches one or more package signature DBs against a target module's own DB,
reporting per package: exact-match rate, fuzzy-match rate, self-collision
rate, and (for fuzzy-only hits) median string-set Jaccard similarity.

```sh
node match.mjs <target.sig.json> <pkg1.sig.json> [pkg2.sig.json ...] \
  [--min-instr N] [--baseline metro-baseline.sig.json]
```

**`--baseline` matters — read this before using the tool without it.** Every
bundle produced by the same Metro+Babel+hermesc toolchain shares a fixed set
of require-runtime/polyfill functions regardless of which npm packages are
actually bundled (`docs/PACKAGE-SIGNATURES.md` §2.3 — found by bundling a
`module.exports = {}` entry point through the identical pipeline: it still
produced 75 Hermes functions). Without subtracting this baseline, match
rates for *every* package — including ones genuinely absent from the target
— are inflated by this fixed floor. Build the baseline DB once per
(Metro version, Hermes bytecode version, opt level) tuple:

```sh
# entry-empty.js: module.exports = {};
npx react-native bundle --platform android --dev false --minify true \
  --entry-file entry-empty.js --bundle-output empty.bundle --assets-dest ./assets-empty
hermesc -O -emit-binary -out=empty.hbc empty.bundle
node --experimental-strip-types build-signatures.mjs empty.hbc metro-baseline 0.76.9 empty.sig.json
```

**Do not** substitute a real package's DB for a dedicated baseline probe on
the theory that "a hash shared by two real packages must be toolchain
noise" — two real packages can legitimately share code via a genuine
dependency relationship (`react-native` depends on `react`), and that
overlap is signal, not noise. Only a deliberately dependency-free probe
bundle is safe to subtract this way. (This was tried, and produced a
methodologically unsound false-negative — see `docs/PACKAGE-SIGNATURES.md`
§2.3's parenthetical.)

`--min-instr N` additionally excludes functions shorter than N instructions
from every rate (a FLIRT-style minimum-length floor — short functions
collide constantly and a lone hash match on a 2-instruction getter is not
meaningful signal). `docs/PACKAGE-SIGNATURES.md` §2.4 used `--min-instr 8`.

## Reproducing the §2 measurement

Everything below runs in scratch, outside this repo, per the task's
instructions (no npm installs or third-party bundles are committed here).

```sh
# 1. Scaffold, matching tests/fixtures/bundles/rn-template-0.72/BUILD.md exactly.
npx --yes react-native@0.72.17 init HelloHermes072 --version 0.72.17 --skip-install --npm
cd HelloHermes072
node -e "const p=require('./package.json'); p.dependencies.lodash='4.17.21'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n')"
npm install

# 2. Four standalone entry points (react/lodash/react-native-core/empty-baseline).
cat > entry-react.js   <<'EOF'
const X = require('react'); module.exports = X;
EOF
cat > entry-lodash.js  <<'EOF'
const X = require('lodash'); module.exports = X;
EOF
cat > entry-rn-core.js <<'EOF'
const X = require('react-native'); module.exports = X;
EOF
cat > entry-empty.js   <<'EOF'
module.exports = {};
EOF

for name in react lodash rn-core empty; do
  npx react-native bundle --platform android --dev false --minify true --reset-cache \
    --entry-file entry-$name.js --bundle-output $name.bundle --assets-dest ./assets-$name
  /path/to/hbc2js/tools/hermesc/v94/hermesc -O -emit-binary -out=$name.hbc $name.bundle
done

# 3. Fingerprint each, plus the target fixture already in this repo.
cd /path/to/hbc2js
for name in react lodash rn-core; do
  node --experimental-strip-types tools/pkgsig/build-signatures.mjs \
    /path/to/scratch/HelloHermes072/$name.hbc $name <version> /path/to/scratch/$name.sig.json
done
node --experimental-strip-types tools/pkgsig/build-signatures.mjs \
  /path/to/scratch/HelloHermes072/empty.hbc metro-baseline 0.76.9 /path/to/scratch/baseline.sig.json
node --experimental-strip-types tools/pkgsig/build-signatures.mjs \
  tests/fixtures/bundles/rn-template-0.72/index.android.hbc rn-template-target n/a /path/to/scratch/target.sig.json

# 4. Match.
node tools/pkgsig/match.mjs /path/to/scratch/target.sig.json \
  /path/to/scratch/react.sig.json /path/to/scratch/lodash.sig.json /path/to/scratch/rn-core.sig.json \
  --baseline /path/to/scratch/baseline.sig.json --min-instr 8
```

Expect (per `docs/PACKAGE-SIGNATURES.md` §2.4): `react-native` ~99% exact,
`react` ~46% exact / ~54% fuzzy, `lodash` (absent from the target) 0% exact
/ ~1.5% fuzzy — the residual `lodash` fuzzy hits are all short, generic
comparator/getter idioms, not evidence of actual lodash presence.

## Known limitations (see docs/PACKAGE-SIGNATURES.md §3–§4 for the full analysis)

- No module-graph/`__d()` anchoring yet (§3.1) — matching is purely
  per-function, which is why `react`'s rate is lower than `react-native`'s
  despite both being genuinely present (§2.4's require-immediate-drift
  finding, §3.2).
- No symbolic require-call-site resolution (§3.2) — a `require()` call's
  baked-in numeric module ID is a real source of false negatives that
  `normaliseFunction` doesn't mask (it's a plain `imm` operand, usually
  semantically meaningful, just not in this one case).
- One Hermes version (94), one opt level (`-O`), two real packages sampled.
  Not a validated general-purpose threshold — see risk S5 in
  `docs/PACKAGE-SIGNATURES.md`.
