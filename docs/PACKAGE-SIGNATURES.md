# Package signatures: feasibility for D17 (npm package recognition)

Task T8. Two parts: §1 surveys prior art for "identify a known library inside
compiled/minified/bundled code" and judges what's reusable; §2–§4 measure
feasibility directly on this repo's own data (react/lodash/react-native
bundled fresh with Metro + `hermesc` v94, matched against
`tests/fixtures/bundles/rn-template-0.72`) and lay out an architecture for the
D17 pass. No `src/**` code was written for this task — everything here is
research plus a standalone prototype under `tools/pkgsig/`.

Date of survey/measurement: 2026-08-30. Companion documents: `docs/DECISIONS.md`
D17/D18, `docs/PRIOR-ART.md` (the Hermes-decompilation survey this one
complements), `docs/TOOLCHAIN.md`, `tools/pkgsig/README.md`.

---

## 1. Prior art

Three communities have solved variants of "recognise known code inside a
blob you can't just diff against source": web-tooling (works on *source or
lightly-minified* JS, keyed on strings/URLs), academic Android/native-binary
library detection (works on genuinely compiled, obfuscated code — closest to
our problem), and binary reverse-engineering function-signature databases
(FLIRT/Function-ID/BinDiff — the direct ancestor of the D17 idea). Verdicts
are about **technique transfer**, not about running the tool itself — none of
these operate on Hermes bytecode, so "reuse" here means "reuse the idea/data
format," never "vendor the code."

### 1.1 JS-world tools (source/string level — mostly inapplicable to bytecode)

| Tool | Licence | What it actually matches on | Reuse verdict |
|---|---|---|---|
| **Retire.js** (`retirejs/retire.js`) | MIT | Per docs/repository/jsrepository.json: four independent extractor kinds per library — `uri` (regex on download URL), `filename` (regex), `filecontent` (regex over **unminified source text**, e.g. `/\*!? jQuery v(§§version§§)`), and `hashes` (SHA-1 → exact version, for byte-identical un-modified files only). No structural/AST/bytecode signature of any kind. | **Data-format idea only.** The `hashes: {sha1: "1.2.3"}` map is exactly D17's simplest tier ("whole-file/whole-function exact hash → version"), and is worth mirroring in the D17 signature DB schema. The regex/`filecontent` extractors are useless post-Hermes-compilation (no source text survives). Never touch the JS code itself (GPL-free but irrelevant — it's regex strings, not an algorithm). |
| **Wappalyzer** | mixed (core Apache-2.0 historically, now partly private) | Regexes over HTML/response headers/global JS variable names (`window.jQuery`, `React.version`) on a **running page**, not a static bundle. | **Not applicable.** No static-analysis component; assumes a live DOM/JS context we don't have (a decompiled `.hbc` is a static artifact, not a running app). |
| **Snyk / Socket.dev / OSV-Scanner** | proprietary (Snyk, Socket) / Apache-2.0 (OSV-Scanner) | All three key off **the package manifest** (`package.json`/lockfile) or, for Socket, static analysis of **unbundled** `node_modules` source (capability detection: does this package call `eval`/`fs`/`child_process`). None re-derives package identity from an already-bundled, already-compiled artifact with no manifest. | **Not applicable** to the "which packages are inside this compiled `.hbc`" problem — they solve "is this manifest-declared dependency risky," a different question that presupposes the manifest survives. |
| **webpack-bundle-analyzer** | MIT | Reads webpack's own build-time `stats.json` (module paths, sizes) — **it doesn't infer anything from the bundle bytes**, it just visualizes metadata webpack already knew. | **Not applicable** — no fingerprinting at all; requires the exact build's own stats output, which is never shipped in a release APK. Confirms by contrast why D17 needs a bytes-only technique: a release bundle has no `stats.json` equivalent (§2.4 below: no `.map`/manifest found in six real corpus APKs either). |
| **webcrack** (`j4k0xb/webcrack`) | MIT | Deobfuscates `obfuscator.io` output, unminifies, and unpacks **webpack/browserify** module wrappers by pattern-matching their runtime (`__webpack_require__`, browserify's `[fn,{},ids]` triple-array format) back into a module graph. Confirmed (WebFetch, 2026-08-30): **no Metro support**, and **no known-library signature matching** — purely structural (recognises *bundler* shape, not *library* identity). | **Reuse the bundler-runtime-pattern-matching idea, not the code.** The technique — recognise the module-registration call shape, recover `id → factory` — is exactly what Metro's `__d(factory, id, deps)` needs (§3.1), just retargeted from a JS-source AST pattern to a Hermes-bytecode instruction pattern. Since it doesn't touch Metro at all, there's no format overlap to check for compatibility with, and MIT wouldn't have blocked reuse anyway. |
| **wakaru** (`pionxzh/wakaru`) | Apache-2.0 | Un-bundles and un-minifies **webpack 4/5, esbuild, Bun, Browserify, Closure ModuleManager, SystemJS, AMD/UMD, and — notably — Metro** (confirmed via WebFetch, 2026-08-30: Metro is explicitly listed as a supported bundler format). Splits a bundle back into per-module files via AST rewriting; a "package inventory" feature (which package/version a bundle ships) is listed as **in development**, not shipped. | **Closest JS-tool analogue, but operates one level up the stack from us** (JS AST, not bytecode) and doesn't yet do library-version identification even at that level. Confirms Metro's `__d`-wrapper structure is a known, previously-reverse-engineered target (independent validation of §3.1's approach) but has nothing shippable to reuse for the bytecode case — the "package inventory" feature, whenever it lands, would face the exact same problem D17 does (post-minification, no source), just on JS text instead of bytecode. Worth re-checking if it ships before D17 is implemented. |
| ad hoc "bundle-scanner" / "unbundle" npm packages | MIT (npm's `unbundle`) | `unbundle` (npm, ~50 SLoC) statically parses a **webpack/browserify** bundle's own `require`-map literal (which, in dev/unminified builds, is a JS object/array literal listing every module verbatim) to split it apart — it works because the map itself is still legible source, not because it fingerprints anything. | **Confirms the "read the map if it's there" family is the cheap path** (§2.4's `.map`/manifest question) but the map is exactly what release Metro bundles (and every APK sampled) don't ship. No code reuse; validates why D17 needs a fingerprinting fallback at all. |

### 1.2 Academic / Android / binary-world (obfuscation-resilient — directly relevant techniques)

| Work | Domain | Core technique | What transfers to Hermes bytecode |
|---|---|---|---|
| **LibScout** (`reddr/LibScout`) | Android/Java bytecode | Builds a **hierarchical class-dependency profile per library version**, normalised to be resilient to identifier renaming and some control-flow obfuscation; matches candidate app classes against a profile database. | The "build one profile per known version, from a clean build of that exact version" workflow is precisely D17's plan (§3). The class-hierarchy-shape signal doesn't transfer (Hermes functions have no class metadata at the bytecode level pre-decompilation), but the **general shape** — normalise, hash, match against a version-pinned DB, report a confidence tier rather than a boolean — transfers directly and is what `tools/pkgsig/` prototypes. |
| **LibRadar** | Android/Dalvik bytecode | **Feature hashing of Android-API call statistics** per class (obfuscation-resilient because it counts *which platform APIs* a class calls, not identifiers) — fast (its main selling point) but coarser than LibScout. | The "count calls to a fixed, un-renameable vocabulary" idea maps to Hermes **builtin-call and property-name usage** (string literals and builtin indices survive renaming/minification intact, per D3/D17's own premise) — already captured by this prototype's `stringSet` tier (§2.2) and worth extending to builtin-call histograms. |
| **LibPecker** | Android/Dalvik bytecode | Hashes **class-dependency graphs** ("fuzzy class matching") rather than individual methods, explicitly to survive inlining/shrinking that breaks method-level signatures; reported as the most obfuscation-resistant of the three in later surveys (`arxiv 2108.01964`). | Directly motivates **whole-module matching over Metro's dependency graph** (§3.1) instead of (or in addition to) isolated per-function hashing — a module's *set of factory functions plus its declared dependency slots* is the closest bytecode analogue of a "class dependency graph," and per this task's measurement (§2.3) is far more robust than any single function hash. |
| **LibID** (Zhang & Beresford, ISSTA'19) | Android bytecode | Explicitly targets resilience to **code shrinking** (tree-shaking) and **package/identifier renaming** simultaneously — the two distortions Metro's production bundling applies (inline requires prune unused exports; Hermes/Metro erase all names). | Directly on-point for D17's threat model. Its core move — treat renaming as already-solved (normalise names away) and focus detection *features* on what shrinking can't remove (call-site shape, not enumerated members) — is exactly the design principle behind normalising registers/cache-slots/names in `src/harness/roundtrip.ts` and reusing it here (§2.1) rather than inventing a new normaliser. |
| **Debun** (ASE'25, Korea Univ.) — bundled-JS-on-web library detection | Minified/bundled **JavaScript**, closest domain match of any academic work found | Targets exactly "40% of the top 1M sites bundle third-party libs, directory structure is lost" — the JS-specific version of this problem, using property-access patterns (which class members get touched) as a resilient, obfuscation-tolerant feature, building on earlier property-pattern approaches LDC (manual patterns) and PTdetector (automatically mined patterns). | The **closest prior art in target domain** (bundled JS, not Android). Property-access-pattern hashing is a fuzzy-tier candidate above and beyond bare opcode-sequence hashing — worth prototyping if opcode/string hashing (§2) proves too brittle across minor version bumps. No code available to inspect (paper only, not checked for a public artifact as of this survey) — technique-only reuse. |
| **IDA FLIRT** | Native binaries (x86/ARM/…) | Per-function byte-pattern signature with variable bytes masked (relocated addresses, etc.); explicit, documented **collision handling** via a `.exc` exceptions file when `sigmake` finds >1 function sharing a pattern, and a "special segregation" pre-pass (identify the compiler first, then pick the matching sig file) to cut cross-toolchain collisions. | **Directly reusable design pattern**, not code (closed-source, and n/a to JS anyway): (a) a minimum-length floor before a signature is trusted at all, (b) an explicit collision list rather than silently picking the first match, (c) "identify the toolchain first" — here, "identify the Metro/Babel/Hermes version combination first" — before trusting any per-function hash. §2.2/§3.3 below independently rediscover exactly this need from measurement (a Metro-runtime "toolchain baseline" that must be subtracted first) before finding FLIRT's write-up during the survey — strong convergent validation. |
| **Ghidra Function ID** | Native binaries | A **cryptographic hash of masked instructions and code flow** per function, stored in a lookup database — conceptually FLIRT's open-source, hash-based (vs. byte-pattern) cousin. | Structurally the closest ancestor of this prototype's `exactHash` tier (hash of a masked/normalised instruction stream) — validates hashing normalised instructions (rather than matching raw byte patterns, which is FLIRT's older approach) as the standard modern technique, which is what `src/harness/roundtrip.ts`'s existing normaliser already does. |
| **BinDiff / Diaphora** | Native binaries, whole-binary diffing | Multi-pass heuristic matching: exact hash/name first, then CFG-shape (basic-block/edge counts) and call-graph-anchored propagation for anything left unmatched, applying ~50 heuristics from most to least reliable (Diaphora). | The **tiered, most-reliable-first matching strategy** (exact hash → structural/fuzzy → confidence-scored, never silently merging tiers) is the direct model for `tools/pkgsig/match.mjs`'s exact/fuzzy split (§2.2) and for D17's proposed confidence thresholds (§3.4). Call-graph propagation (once function A matches, its callees/callers become more likely to match too) is **not yet implemented** in the prototype and is a good v2 addition — Metro's dependency array already gives the call/require graph for free (§3.1), so this is cheaper here than in the general binary case. |

### 1.3 Metro/Expo's own metadata (checked directly, not surveyed)

- **Metro module-ID ↔ path map**: exists only as the `--sourcemap-output`
  `.map` file's `x_facebook_sources`/`sourcesContent` extension and
  `metro-symbolicate`'s consumption of it — i.e., it is source-map metadata,
  generated at build time, and is the closest thing to a free win **if it
  ships**. §2.4 checks whether it does in practice (it doesn't, in every real
  corpus APK sampled).
- **Expo's `expo export` manifest** (`metadata.json`/`assetmap.json` via
  `--dump-assetmap`): lists *assets* (images/fonts) for OTA update delivery,
  not JS module identity — not useful for package recognition even when
  present.

### 1.4 Bottom line for §1

No tool anywhere does "recognise an npm package inside compiled Hermes
bytecode" — expected, since Hermes bytecode is a narrow, recent target. The
useful transfer is entirely at the level of **technique**, concentrated in
the Android third-party-library-detection literature (same problem — a
managed-language bytecode target, name-erasing obfuscation, code shrinking —
solved for a sibling bytecode format) and in binary-RE signature databases
(FLIRT/Function-ID/BinDiff for the tiered-matching, collision-handling, and
"identify the toolchain first" design patterns). `src/harness/roundtrip.ts`'s
existing D3 normaliser already embodies LibID's core insight (normalise away
renaming, then hash) — §2 reuses it directly rather than writing a second
normaliser, and §3 borrows FLIRT's minimum-length floor and Diaphora's tiered
matching, plus a Metro-specific whole-module anchor that has no binary-RE
analogue at all (§3.1) because Metro (unlike a linker) leaves the
module/dependency graph as literal, un-optimised-away bytecode.

---

## 2. Feasibility measurement

### 2.1 Setup

Per `tests/fixtures/bundles/rn-template-0.72/BUILD.md`: fresh RN 0.72.17
template, scaffolded in scratch (outside this repo), with `lodash@4.17.21`
added to `package.json`. Versions in the resulting `node_modules` matched the
target fixture's exactly: **react 18.2.0, react-native 0.72.17** (`lodash`
4.17.21 is not a react-native dependency and is not in the target fixture at
all — used as the "package NOT in the template" false-positive probe, §2.2).

Four standalone Metro entry points, each `require()`-ing exactly one thing
(so Metro's whole reachable dependency graph for that package gets pulled
into one bundle, per-file tree-shaking of *unused exports* aside — Metro 0.76
does not do export-level dead-code elimination, only reachability):

```js
// entry-react.js / entry-lodash.js / entry-rn-core.js
const X = require('react' | 'lodash' | 'react-native');
module.exports = X;
// entry-empty.js — the toolchain-baseline probe, §3.3:
module.exports = {};
```

Each bundled with `npx react-native bundle --platform android --dev false
--minify true` (same flags as the target fixture) and compiled with
`tools/hermesc/v94/hermesc -O -emit-binary` (byte-identical binary to the one
`react-native@0.72.17` itself ships, per `docs/TOOLCHAIN.md`).

| Bundle | Metro modules (`__d(` count) | `.bundle` size | Hermes functions (post-`hermesc -O`) |
|---|---|---|---|
| `react.bundle`/`.hbc` | 3 | 15,889 B | 131 |
| `lodash.bundle`/`.hbc` | 1 | 82,171 B | 760 |
| `rn-core.bundle`/`.hbc` | ~370 | 810,937 B | 4,165 |
| `empty.bundle`/`.hbc` (baseline probe) | 1 | 9,278 B | 75 |
| `rn-template-0.72/index.android.hbc` (target, committed fixture) | 435 | 820,822 B | 4,199 |

`rn-core`'s function count (4,165) landing within 1% of the real target
fixture's (4,199) is itself a sanity check: a standalone `require('react-native')`
bundle is structurally almost the whole app.

### 2.2 Fingerprint tiers (`tools/pkgsig/build-signatures.mjs`)

Reuses `src/harness/roundtrip.ts`'s existing `normaliseFunction` (the D3
round-trip normaliser: registers renamed by first appearance, cache-slot
indices dropped, function names masked except `global`, string/bigint/builtin
literal *content* kept) — no new normaliser was written, per this task's
"reuse `normaliseFunction`" framing and the D12 principle of one canonical
normal form. Three tiers computed per function, from that same decoded form:

1. **`exactHash`** — `sha256` of the full `normaliseFunction` text. Byte-for-byte
   structural identity modulo register/cache-slot/name-erasure — the
   Ghidra-Function-ID analogue (§1.2).
2. **`fuzzyHash`** — `sha256` of the bare mnemonic sequence with **every**
   operand stripped (not just cache slots — string/bigint/builtin content
   too), switch instructions collapsed to `SWITCH(caseCount)`. Tolerant of
   literal-content drift; still requires the same instruction sequence.
3. **`stringSet`** — sorted de-duplicated string-literal operands, used only
   as a Jaccard-similarity secondary signal on top of a fuzzy-hash hit, per
   Diaphora's multi-heuristic model (§1.2) — never its own hash tier, since
   two functions with the same string set but different code are common
   (e.g. two error-formatting wrappers around the same message).

### 2.3 Toolchain-baseline subtraction (the load-bearing finding)

**Naive matching overstates every rate.** Matching `react.sig.json` against
the target fixture directly gives a 59.5% exact-match rate — but 45 of those
78 hits are functions at bytecode-function-index <75 in *every* bundle
sampled, including `lodash.sig.json` (which shares zero real source with
`react`). Dumping one (`lodash` function #10, 15 instructions) shows it's
Metro's own require-runtime (`.forEach` over a module's declared
dependencies, registering each with the module registry) — not library code
at all. This is the FLIRT "identify the toolchain first" lesson (§1.2)
rediscovered empirically: **every bundle built by the same Metro+Babel+hermesc
combination shares a fixed set of runtime/polyfill functions, independent of
which npm packages are present**, and naive hashing attributes all of them to
whichever package's DB happens to be checked first.

Fix: `entry-empty.js` (`module.exports = {}`) bundled through the identical
pipeline isolates exactly this baseline — Metro still emits its full
require-runtime and injected polyfills for a bundle with **zero** npm
dependencies. `tools/pkgsig/match.mjs --baseline empty.sig.json` excludes
these 75 hashes from every package's rate. (An earlier, methodologically
unsound attempt — flagging any hash shared by ≥2 *real* package DBs as
"baseline" — was tried and rejected: `react` and `react-native` legitimately
share code, since `react-native` depends on `react`, and that pairwise
overlap is genuine signal, not noise. Only a dependency-free probe bundle is
safe to subtract this way — see the warning in `tools/pkgsig/match.mjs`.)

### 2.4 Results

`node tools/pkgsig/match.mjs target.sig.json react.sig.json lodash.sig.json
rn-core.sig.json --baseline empty.sig.json --min-instr 8` (a length floor,
per FLIRT §1.2, additionally excludes the shortest, most collision-prone
functions):

| Package | In target? | Functions (eligible after baseline+floor) | Exact-match rate | Fuzzy-match rate |
|---|---|---|---|---|
| `react-native@0.72.17` | yes | 3,360 | **99.2%** (3,333/3,360) | 99.2% (no fuzzy-only adds) |
| `react@18.2.0` | yes | 39 | **46.2%** (18/39) | 53.8% (21/39) |
| `lodash@4.17.21` | **no** | 599 | **0.0%** (0/599) | 1.5% (9/599, fuzzy-only) |

Without the length floor (`--min-instr 0`, baseline still subtracted):
`react` 52.8%, `lodash` 2.2% exact / 5.2% fuzzy, `react-native` 99.3% — the
floor mainly trims `lodash`'s residual false positives (all 15 of its
exact-hash hits below the floor were ≤7-instruction generic comparator/getter
idioms, e.g. `lodash#112`, 6 instructions, 2 params — structurally identical
to unrelated 2-line functions elsewhere in the target for reasons unrelated
to lodash's actual presence) without moving `react-native`'s rate.

**Why `react-native` (99.2%) so drastically outperforms `react` (46.2%)**,
despite both genuinely being inside the target: the one large `react-native`
non-baseline miss is function #0 (`global`, 2,225 instructions) — the
top-level module-registration driver, which necessarily differs because the
standalone bundle's entry point and full module list differ from the real
app's `index.js`. The other ~26 misses (out of 3,929 eligible) are, on
inspection, functions containing `require()` call sites: Metro's Babel
transform bakes the **numeric-literal module ID** directly as an immediate
bytecode operand at the call site of `require()`/`d[]` lookups, and that
numeric ID depends on the *global* module-graph position, which differs
between a from-scratch standalone bundle and the full app (`normaliseFunction`
masks string/bigint/builtin/function-name operands but not plain `imm`
operands, since those are usually semantically meaningful — this is one case
where they aren't). `react`'s far lower rate is the same effect at much
higher density: react's ~56 non-baseline functions include many with
internal `require()`s (it's `react` + `react-dom`'s shared internals folded
together by Metro's module graph, even bundled "alone"), so a much larger
fraction of its functions carry a require-call-site immediate that only
matches by chance. This is not a false negative in the sense of "the
function differs" — the *code* is identical; only one baked-in integer
differs. §3.2 proposes the fix (mask the operand, or resolve requires
symbolically before hashing).

Manual cross-check of `react`'s 33 non-baseline exact hits (before the
length floor) by name: `isMounted`, `enqueueForceUpdate`,
`enqueueReplaceState`, `enqueueSetState`, `forEach`, `count`, `toArray`,
`only` — these are the literal `React.Children`/`ReactNoopUpdateQueue` API
surface, i.e. genuine, specific, correctly-attributed matches, not generic
noise (contrast with `lodash`'s false positives, all anonymous/tiny).

### 2.5 The `.map`/manifest shortcut: checked against the real corpus, does not exist

Per this task's instruction, `~/hbc2js-local-corpus/apks/*.apk` (6 apps:
Bloomberg, Discord, Microsoft Teams, Xbox, Pinterest, Shopify — not copied
into this repo) were listed (`unzip -l`), not extracted:

- **Zero `.map` files** in any of the six APKs. Release Android builds do not
  ship Metro source maps in the package (expected — they're uploaded
  separately to a symbolication service, per the `metro-symbolicate`/Sentry
  docs found in §1.3).
- Discord's `assets/manifest.json` and Teams's per-bundle
  `manifest/manifest.json` files exist but are **not** Metro module maps —
  Discord's is a CodePush-style asset-hash manifest (`{"hashes": {"path":
  "md5"}}` for update-diffing) and Teams's is a micro-frontend registration
  descriptor (`{"name", "id", "version", "views"}` for its own internal
  plugin host) — coincidental naming only, verified by inspecting content.
- All Hermes-bundle-shipping APKs (Bloomberg, Discord, Xbox, Shopify — 4/6;
  Teams ships three separate `hermes.android.bundle` files, Pinterest ships
  no JS bundle at all, likely a non-RN or fully-native screen set) had `.hbc`
  magic bytes (`c6 1f bc 03 c1 03 19 1f`) confirmed directly at the asset's
  first 16 bytes, versions 96 (Bloomberg, Teams, Xbox) and 98 (Discord,
  Shopify) by byte offset 8 — consistent with `docs/TOOLCHAIN.md`'s version
  table for their approximate RN release eras.

**Conclusion: the map/manifest shortcut is not a real-world fallback.**
Fingerprinting from bytecode alone (§2.1–§2.4) is the only path that will
work against an actual shipped APK; sourcemap-based recovery is a
nice-to-have for a developer's own local build only.

---

## 3. Recommended architecture for the D17 pass

### 3.1 Whole-module anchoring first, function hashing second

Metro's `__d(factory, id, deps)` registration call is not optimised away —
it is ordinary bytecode in each bundle's `global` function. Dumping
`global`'s normalised disassembly (`react.hbc`, this task's prototype)
confirms the exact shape:

```
TryGetById %6, %3, s#"__d"
CreateClosure %1, %0, f#"~"        ; %1 = this module's factory function
LoadConstUInt8 %2, 2               ; %2 = its Metro module id (2)
NewArray %0, 0                     ; %0 = its dependency-id array ([])
Call4 %0, %6, %5, %1, %2, %0       ; __d(factory, 2, [])
```

A single pattern-match pass over `global` (find every `TryGetById …
"__d"` → `CreateClosure` → `Call4`/`Call5` triple) recovers, **for any Hermes
bundle, with no fingerprinting at all**: which Hermes function index is each
Metro module's factory, that module's numeric id, and its ordered
dependency-slot → id array — i.e. the complete module graph shape (LibPecker's
"class dependency graph" analogue, §1.2), for free, before any signature
lookup happens. D17 should build this map first, then:

1. Hash each **factory function** (module-level, one Hermes function) with
   §2.2's tiers — a whole-module match is "this factory function's
   `exactHash` equals some known package version's known-module-index N,
   *and* its recovered dependency-count matches N's known dependency count."
2. Only fall back to matching *individual* nested functions inside a factory
   (helper closures a module defines) when the factory-level hash misses —
   e.g. because of the require-immediate drift in §2.4/§3.2 — using the
   recovered dependency graph to disambiguate which package's DB to check
   first (Diaphora's call-graph-propagation idea, §1.2: a nested function's
   package is very likely whatever its enclosing factory already matched).

### 3.2 Fix the require-immediate false-negative before matching, not after

§2.4 root-caused most of `react`'s and `react-native`'s misses to one
mechanical cause: `require()`/`d[]` call sites bake the numeric global module
ID as a plain immediate operand, which `normaliseFunction` does not mask.
Two fixes, either sufficient alone, in priority order:

1. **Resolve requires symbolically before hashing.** Since §3.1 already
   recovers each module's `deps` array (ordered list of numeric ids), a
   `require(d[N])`/`r(d[N])` call site's *target* can be resolved to "the
   Nth dependency of this module" — a **position**, not a raw global id —
   and hashed as `dep#N` instead of the literal. This is the correct fix: it
   turns a build-environment-sensitive integer into a build-independent
   symbol, at the cost of needing the module-graph recovery of §3.1 to run
   first (fingerprinting therefore cannot be a purely per-function,
   context-free pass — it needs the enclosing module's `deps` array in
   scope).
2. **Cheaper fallback**: extend `normaliseFunction`-for-signatures (a D17-local
   variant, not a change to the D3 oracle normaliser, which must stay
   byte-exact for round-trip diffing) to mask *every* `imm`-typed operand
   immediately preceding a call to a resolved `__d`-registered `require`
   binding. Blunter — masks real semantic differences too on the rare
   collision — but needs no graph context.

### 3.3 Signature DB format

Mirror Retire.js's `hashes: {sha1: version}` shape (§1.1) at function
granularity, plus the fuzzy tier and the FLIRT-style pieces §1's academic
survey converged on:

```jsonc
{
  "package": "react", "version": "18.2.0",
  "toolchain": { "metro": "0.76.9", "hermesVersion": 94, "hermescFlags": "-O" },
  "modules": [ // recovered via §3.1, one entry per __d()-registered module
    { "localId": 2, "depCount": 0, "exactHash": "…", "fuzzyHash": "…",
      "nestedFunctions": [ { "exactHash": "…", "fuzzyHash": "…", "stringSet": […] } ] }
  ],
  "toolchainBaseline": false // true only for the dedicated empty-entry probe DB
}
```

- **Version pinning**: one DB per (package version, Metro version, Hermes
  bytecode version, opt level) tuple — §2.1 shows a single opt level
  (`-O`, this toolchain's default) already produces version-sensitive
  output (`docs/TOOLCHAIN.md`'s v96/v98/v99 opcode-table differences mean a
  react DB built against v94 hermesc cannot be assumed to match a v98
  target's react functions even at the fuzzy tier — validate per-version,
  don't extrapolate). Building the DB is cheap (§2.1: minutes, no native
  build) so this is a storage/maintenance cost, not a compute one — plan for
  one DB per popular package × {last N major versions} × {each HBC version
  in `docs/TOOLCHAIN.md`'s table}, generated by CI, not hand-curated.
- **Toolchain baseline is mandatory infrastructure, not optional**: §2.3
  showed naive matching is unusable without it. One baseline DB per
  (Metro version, Hermes version, opt level) tuple, built once from
  `entry-empty.js`, checked into the signature-DB store (small: 75 functions
  here) and subtracted before every other match.

### 3.4 Confidence thresholds and what the emitter needs

Per D17's text ("a high-confidence whole-module match is emitted as
`require("<pkg>")`… partial matches are annotated, never silently
replaced") and this measurement:

| Tier | Condition | Action |
|---|---|---|
| **High** | Recovered module's factory-function `exactHash` matches a known package-version's module N **and** the re-bundle-and-recompile check (D17's own text: "re-bundles the replacement and confirms bytecode equality") round-trips clean | Emit `require("pkg")`, add a `package.json` dependency entry |
| **Medium** | Factory `exactHash` misses (likely §3.2's require-immediate drift) but `fuzzyHash` + dependency-count + nested-function exact-hash-rate (§2.4: react's real internals cleared ≥50% even before the §3.2 fix) clear a threshold — recommend **≥50% of a module's nested functions exact-matching**, based on §2.4's true-positive floor, tuned once real §3.2 data exists | Emit a **comment annotation** naming the candidate package/version, keep the decompiled body (never replace code on a fuzzy match alone — this is the D17 text's explicit rule, and lodash's own false-positive floor at this tier was 1.5%, §2.4, not zero) |
| **Low** | Isolated function-level exact/fuzzy hit with no enclosing-module corroboration | Ignore for `require()` purposes; may still feed a "this looks like known open-source code" hint pass later, out of scope for D17 v1 |

A minimum-instruction floor (§2.2, ≥8 instructions here) applies before any
tier is considered — below it, collision rates (self-collision counts in
`tools/pkgsig/match.mjs`'s own DBs: `lodash` alone had 47/760 exact
self-collisions) make a lone hash meaningless, exactly FLIRT's rationale.

---

## 4. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| S1 | **Require-immediate drift** (§2.4/§3.2) silently depresses true-positive rates for any package with internal cross-file requires (worse for larger packages with more internal module splitting) unless §3.2's symbolic-resolution fix ships with the pass, not after. | Under-detection, not over-detection — safer failure mode than false `require()` emission, but weakens D17's headline value prop | Ship §3.2 fix #1 (symbolic dep-slot resolution) in the same commit as the first real signature DB, not as a follow-up; §2.4's 46%→? delta after the fix is worth re-measuring before committing to the confidence thresholds in §3.4. |
| S2 | **Toolchain-baseline staleness.** A baseline DB is only valid for its exact (Metro, Hermes, opt-level) tuple; RN/Metro ships new versions constantly, and `docs/TOOLCHAIN.md` already documents 5+ live HBC versions. Forgetting to regenerate the baseline after a Metro bump reintroduces §2.3's ~45-function noise floor silently. | False positives creep back in exactly the packages people care about least (anything short/generic) | Generate the baseline DB in the same CI job/script that builds each package's signature DB for a given toolchain tuple, never hand-maintained; `tools/pkgsig/README.md` documents the invariant. |
| S3 | **Version resolution ambiguity.** Two adjacent patch versions of a popular package (e.g. lodash patch releases) may be byte-identical at the Hermes-bytecode level for functions neither patch touched, and differ only in the touched ones — a "high confidence" match might pick the wrong patch version. Not measured directly in this task (only one version of each package was built). | Wrong version pinned in the emitted `require()`/`package.json` entry (semantically harmless for `require()` itself, but could mislead a human reader or a later SBOM step) | Report the **set** of candidate versions consistent with all matched modules, not a single guess, when more than one known version shares every matched hash; only emit a single version when it's uniquely determined. |
| S4 | **Malicious/patched packages.** A supply-chain-compromised or hand-patched copy of a real package will (correctly) fail the exact-hash tier for its changed functions and may fall to "medium"/annotation tier or lower — D17 must not *decompile worse* just because a package looks "almost" known; the correct-but-ugly decompiled form must always remain the fallback (same principle as D12's checker-gated passes generally). | A confidently-wrong `require()` substitution would be a correctness regression, not just a readability one | Never substitute (`require()` emission) below the "High" tier's round-trip-recompile-and-diff check (D17's own text); this is already the plan, flagged here only as the reason that check is non-negotiable, not optional tuning. |
| S5 | **Small sample size.** This measurement used exactly two real packages (react, react-native) plus one deliberately-absent probe (lodash), one Hermes version (94), one opt level (`-O`), against one target fixture. Rates in §2.4 are a first data point, not a validated general-purpose threshold — `docs/TASKS.md`'s T8 scope was explicitly a feasibility study, not the D17 implementation itself. | Thresholds in §3.4 may need retuning once more packages/versions are sampled | Before implementing D17 for real: repeat §2's measurement against `react-navigation-example-0.85.3`/`expensify-app-0.86.0` (v98, different Hermes version and a much larger, more realistic dependency set) to check whether the ~99%/~50%/~0% pattern found here holds outside the single-fixture, single-HBC-version case this task covered. |

---

## Summary for future readers

**Feasible, with a load-bearing caveat found only by measuring, not by
reading prior art.** Reusing the existing D3 normaliser (`src/harness/roundtrip.ts`)
to hash every function gets real signal — `react-native` core matches the
real fixture at 99%+, `react`'s genuine internals are cleanly and
specifically recoverable (`React.Children.{forEach,count,toArray,only}` by
name), and an absent package (`lodash`) produces a near-zero false-positive
floor — but **only after subtracting a Metro/Babel/hermesc toolchain
baseline** (a fixed ~75-function floor every bundle shares regardless of
contents, found by bundling a dependency-free entry point) and applying a
short-function collision floor. Both fixes came from the FLIRT/Diaphora
binary-RE literature (§1.2), independently rediscovered by this
measurement before the literature review located them — a genuine
convergent-validation result, not a coincidence. The real, mechanically-fixable
gap is require-call-site immediate operands (§2.4/§3.2), not fundamental
infeasibility; §3 proposes the fix and the module-graph-anchored architecture
(exploiting Metro's un-optimised `__d()` calls, §3.1) needed to apply it.

---

## 5. Prototype v2 results (T8 follow-up, 2026-08-30)

Turns §2–§4's feasibility study into a working pipeline: `tools/pkgsig/build-db.mjs`
(bundle → compile → fingerprint, end to end) and `tools/pkgsig/match.mjs` v2
(per-package *and* per-Metro-module attribution with confidence tiers),
measured on real fetched apps and the local production-APK corpus, not just
the two-package single-fixture sample §2 used. No `src/**` code was touched;
the require-immediate fix lives in a pkgsig-local fork of the normaliser
(§5.1), per the task's ownership split with the M4 decompiler agent.

### 5.1 The require-immediate fix, and what it actually turned out to be

§3.2 proposed two fixes for the require-call-site immediate found in §2.4.
Fix #2 (mask the operand) is implemented in `tools/pkgsig/lib/sig-normalise.mjs`,
a **fork** of `src/harness/roundtrip.ts`'s `normaliseFunction` (not a change to
it — D3 requires that oracle to stay byte-exact for round-trip diffing).
Disassembling the actual call-site pattern (`tools/hermesc/v94`, a real
`react` bundle) shows Metro's factory functions always receive the
dependency-map array as their **last** declared parameter, and a
`require(d[N])`/`_dependencyMap[N]` access compiles to one of two shapes:

```
LoadParam %d, <lastParamIndex>     ; %d = dependencyMap array (always last param)
LoadConstZero %i                    ; %i = N (a plain imm operand)   -- v94/v96
GetByVal %v, %d, %i                 ; %v = d[N]
```
```
LoadParam %d, <lastParamIndex>
GetByIndex %v, %d, N                ; N baked directly as an imm operand -- v98+/-O
```

`sig-normalise.mjs`'s `findDependencyIndexOperands` does a flat forward scan
per function (dependency-map param is always last, so no cross-function
context is needed — unlike §3.1's fix #1, this needed no module-graph
resolution) recovering every such `N` and masking it to a canonical `dep#`
token instead of the literal, for both instruction shapes above, across
every HBC version's opcode table (`GetByIndex` didn't exist as a distinct
opcode before v98 — `src/tables/generated/opcodes-hbc98-2024.ts` — so v94/v96
only ever hit the `GetByVal`+`LoadConst*` shape; the scan handles both
uniformly).

**Measured effect, and an important negative result.** Re-matching
`react@18.2.0` (standalone bundle) against `rn-template-0.72`'s target fixture
moved exact coverage from 46.2% (§2.4) to 48.7% — real, but nowhere near the
task's ">90%" target. Root-causing the remaining misses (by diffing
normalised text function-by-function, not just aggregate rates) found that
**most of react's remaining non-matching functions have zero opcode-sequence
overlap at all with anything in the target**, not a masked-vs-unmasked
operand difference — i.e., the dominant remaining gap for `react` specifically
is not the require-immediate issue §2.4 flagged, it's something else (one
function inspected in detail, react's ~210-instruction module-top-level
scope-setup body, differs from every similarly-sized target function starting
at instruction 2 — a different `LoadParam` index — meaning the two aren't
actually the same source construct at all; not conclusively root-caused
further within this task's time budget). Two things rule out toolchain/version
drift as the explanation, which was the first hypothesis tried: (a) rebuilding
the identical `entry-react.js` bundle in two independently-`npm install`-ed
scratch projects produced **byte-identical** `.hbc` output (verified by
sha256), and (b) rebuilding `rn-template-0.72`'s entire app bundle fresh,
today, in this session, produced a bundle **99.99% byte-identical** to the
already-committed fixture (the only diff: the scaffolded project's own name
string and consequently-shifted minifier variable letters in one
unrelated module — nothing to do with react). So the effect is real and
reproducible, not environmental noise, but its root cause is still open —
flagged as follow-up work below, not swept under the rug.

**However, whole-module anchoring (§3.1) tells a much better story than the
per-function rate, and is the number that should actually be trusted.**
Matching `react`'s *module-level* factory-function hashes (recovered by
`tools/pkgsig/lib/dscan.mjs`, §5.3) against `rn-template-0.72` finds **2 of
react's 3 `__d()`-registered modules match exactly** — i.e. two-thirds of
react's own module graph is byte-for-byte identical to what's inside the real
app, including the module containing the bulk of React's actual API surface.
`react-native` does even better: **422/422 modules match exactly** (100%),
with the per-function exact rate at 99.2% (unchanged from §2.4 — react-native
was never the problem). Per docs §3.4's own architecture (module match first,
function-level as a fallback signal), `match.mjs` v2 (§5.4) uses module-count
agreement as its primary "high confidence" signal for exactly this reason —
a package's *function-level* percentage can look mediocre while its
module-level identity is unambiguous.

### 5.2 Toolchain-baseline handling, made principled

§2.3/§3.3 established that a Metro/Babel/hermesc toolchain has its own fixed
"noise floor" of require-runtime/polyfill functions, and that it must be
subtracted before any package's match rate means anything. v1 subtracted a
single flat baseline at match time; v2 makes this a **named, versioned,
layered artifact** built the same way every other signature is built:

1. **`metro-toolchain-empty@<metro-version>__hbc<N>.json`** — `build-db.mjs
   --hbc-file <compiled empty-entry .hbc> --baseline metro-toolchain-empty`.
   Built from `module.exports = {};` bundled through the target (RN version,
   Hermes version) combination. This is the direct successor of §2.3's probe.
2. **`react-foundation@<version>__hbc<N>.json`** and
   **`react-native-foundation@<version>__hbc<N>.json`** — the same idea, one
   layer up: since virtually every real RN bundle contains react and
   react-native, and §2.3's own parenthetical warns against ever subtracting
   a *real* package's DB as if it were noise (genuine dependency overlap is
   signal), these two are built and named explicitly as **foundations**, not
   folded silently into the toolchain baseline. `build-db.mjs`'s `--subtract`
   flag takes a comma-separated list of these three files' `exactHash` sets
   and removes any matching function from a downstream package's *stored*
   function list before writing it — done once, at DB-build time, not
   redundantly at every `match.mjs` invocation (v1's `--baseline` flag is
   gone; every DB under `tools/pkgsig/db/` already has the layered
   subtraction baked in, `tools/pkgsig/db/_baselines/` holds the reusable
   baseline files themselves and their own raw, un-subtracted function sets).

This has a large, immediately visible effect on DB size and correctness: a
package that transitively includes react-native (nearly all of them do, since
Metro has no export-level tree-shaking, §2.1) would otherwise ship a second
full copy of react-native's ~4,000 functions in its own signature file. Before
subtraction, `@react-navigation/native`'s raw HBC94 fingerprint was 4,886
functions (1.7 MB); after subtracting the three foundations, 860 (304 KB) —
an 82% reduction, and the 860 remaining are the package's actual own code,
not noise. `redux`: 124 → 36. `@react-native-async-storage/async-storage`:
4,221 → 51 (it's a thin native-module shim; almost everything it pulls in
*is* react-native). Every DB's `rawFunctionCount` field keeps the
pre-subtraction count for transparency; `subtractedBaselines` records exactly
which files were subtracted.

**Baselining a new toolchain** (documented here and in
`tools/pkgsig/README.md`, since this is exactly the "how does a new toolchain
get baselined" question the task asked for): for a new (RN version, Hermes
bytecode version) pair not already covered —

1. Scaffold or reuse a project pinned to that RN version (`tests/fixtures/bundles/*/BUILD.md`
   have working recipes for the RN-CLI path; the Expo path needs a temporary
   entry-file swap, §5.5).
2. `build-db.mjs metro-toolchain-empty@<metro-version> --project <dir> --hbc <N> --baseline metro-toolchain-empty`
   with a `module.exports = {};` entry (or `--hbc-file` if bundled by hand).
3. Same for `react@<version>` and `react-native@<version>`, each with
   `--baseline react-foundation` / `--baseline react-native-foundation`.
4. Every subsequent `build-db.mjs` call for that (RN, hbc) pair passes
   `--subtract <the three files from steps 2-3>`.

This task did exactly that for three toolchains: HBC94 (RN 0.72.17, plain
RN-CLI `react-native bundle`, empty baseline = 75 functions), HBC96 (same RN
0.72.17 source **recompiled** with `tools/hermesc/v96` — a legitimate
shortcut since HBC version is a property of the compiler invoked, not the
Metro/Babel output text, §5.5), and HBC98 (RN 0.85.3, Expo's `expo export`
bundler — a **structurally different** empty baseline: 414 functions, not
75, because Expo's own runtime/polyfill layer on top of Metro is much
heavier than plain RN-CLI's. This by itself is a load-bearing finding for S2
below: "the toolchain baseline" is not one number, it depends on the
*bundler*, not just the RN/Hermes version pair.

### 5.3 Signature DB format v2

One JSON file per `package@version` × HBC version
(`tools/pkgsig/db/<pkg>@<version>__hbc<N>.json`, `@scope/name` packages get
`__` in place of `/`), schema 2:

```jsonc
{
  "schema": 2,
  "package": "redux", "version": "4.2.1", "hbcVersion": 94,
  "totalFunctions": 36,        // after baseline subtraction (§5.2)
  "rawFunctionCount": 124,     // before subtraction — transparency, not used by match.mjs
  "subtractedBaselines": ["_baselines/metro-toolchain-empty@0.76.9__hbc94.json", "..."],
  "functions": [
    { "index": 7, "name": "", "paramCount": 3, "instrCount": 42,
      "exactHash": "…24 hex chars…",   // sha256, truncated to 96 bits — §5.3 note below
      "fuzzyHash": "…", "stringSetHash": "…", "stringCount": 5 }
  ],
  "modules": [   // recovered via dscan.mjs (§3.1's whole-module anchor), one per __d() registration
    { "factoryFunctionIndex": 7, "localModuleId": 2, "depCount": 3, "depIds": [0,1,4],
      "factoryExactHash": "…", "factoryFuzzyHash": "…",
      "nestedFunctionCount": 4, "functionSetHash": "…", "factoryIsBaseline": false }
  ],
  "toolchainBaseline": false,
  "provenance": {
    "packageSha256": "…",       // sha256 over a sorted relpath+filehash manifest of node_modules/<pkg> (§5.5 — not a registry tarball hash)
    "metroVersion": "0.76.9", "reactNativeVersion": "0.72.17",
    "hermescVersion": 94, "hermescRnEra": "0.72.x",
    "repoCommit": "<this repo's git HEAD at build time>",
    "builtAt": "2026-08-30T…"
  }
}
```

Three per-function tiers, per the task's spec: **exact** (`sig-normalise.mjs`'s
masked-canonical-hash, §5.1), **fuzzy** (bare mnemonic sequence, unchanged
from §2.2 — already invariant to the require-immediate issue since it drops
*every* operand, which is why §2.4's gap was exact-only), and **string-constant
set** — stored as a **hash of the sorted set**, not the raw string array
(§2.2's v1 format kept the full array for a Jaccard-similarity secondary
signal; v2 trades that away for file size, per the task's "compact — hashes
and metadata, not code" requirement — `match.mjs` uses hash equality as a
corroboration signal on fuzzy-only hits instead). All three hashes are sha256
truncated to 24 hex characters (96 bits) — a deliberate size/collision-risk
trade documented in `fingerprint.mjs`; no DB in this task's starter set
exceeds 9,000 functions, so a birthday-bound collision is not a realistic
risk at this scale. `tools/pkgsig/db/index.json` is a flat manifest (package,
version, hbcVersion, path, total/baseline flag) for discovery without
opening every file.

**Size, in practice**: 48 files (16 starter packages × up to 3 HBC versions,
§5.5, plus 9 baseline files across the 3 toolchains), 16 MB total, largest
single file 1.4 MB (`@react-navigation/stack` at HBC98 — it transitively
re-includes react-native-screens/gesture-handler-adjacent code that isn't
covered by any of the three subtracted foundations, an acknowledged residual
of the "only subtract the two most-foundational packages" design, §5.2's own
limitation carried over from §4's risk S3-adjacent reasoning). Every
individual file is under 2 MB.

### 5.4 Matching: `tools/pkgsig/match.mjs` v2

```sh
node --experimental-strip-types tools/pkgsig/match.mjs <bundle.hbc> --db tools/pkgsig/db [--min-instr 8] [--json]
```

Two report sections, per the task's spec:

1. **Whole-bundle package summary** — for every HBC-version-eligible package
   DB (baselines included, so react/react-native's own presence is still
   reported, not just third-party packages), exact/fuzzy function coverage,
   module-exact-match count, and a confidence tier.
2. **Per-Metro-module attribution** — every `__d()`-registered module
   recovered from the *target* bundle (`dscan.mjs`) is looked up by its
   factory function's exact hash against a reverse index built from every
   eligible package's own function set; modules with no owner are reported as
   **unmatched**, sorted by instruction count (the size proxy used — no raw
   byte-range is tracked per function in this format, §5.3), which is exactly
   where genuine first-party app code should surface.

**Confidence tiers** (revised once during this task, see below):

| Tier | Condition |
|---|---|
| High | `moduleExactHits >= 3`, or `moduleExactHits >= 1` **and** module coverage ≥5%, or overall exact-function coverage ≥90% |
| Medium | overall fuzzy coverage ≥50%, or exactly 1–2 module-exact hits |
| Low | any exact/fuzzy hit at all, below Medium's floor |
| None | zero hits after the `--min-instr` floor |

The first version of this table used FLIRT's own naive rule from §3.4
(`moduleExactHits > 0` alone ⇒ High) and it was wrong in an instructive way:
on the real Bloomberg/Xbox APK measurements (§5.6) a package with a *single*
coincidentally-matching module out of hundreds looked identical, by tier, to
one matching dozens — exactly the single-hash-collision risk §1.2's FLIRT
discussion warned about, rediscovered again (the second time convergent
validation from that literature has shown up empirically in this task,
after §2.3's toolchain-baseline finding). Requiring either several
independent module hits or a non-trivial fraction of the package's own module
count fixes it without giving up the core "module match beats raw function
percentage" insight from §5.1/§3.1.

### 5.5 Signature DB built for the starter set

HBC94 and HBC96 (recompiling the *identical* Metro-output JS text with
`tools/hermesc/v96` instead of `v94` is legitimate — HBC version is a
property of which `hermesc` binary is invoked, not of the Metro/Babel
JS-level output, confirmed by using this exact shortcut to get HBC96 coverage
at negligible extra cost): all 16 requested packages, built against a single
scratch RN 0.72.17 project (`react` 18.2.0, `react-native` 0.72.17, plus the
other 14 at whatever `npm install` resolved on 2026-08-30 — versions recorded
per-file in `provenance`, e.g. `axios` resolved to 1.20.0, `react-native-reanimated`
to 3.19.5). No BUILD.md in this repo pins exact versions for any of these 14
beyond RN itself (checked directly, §5's task instruction), so "current npm
resolution on the build date" is the documented, reproducible policy —
recorded in `provenance.builtAt`/`packageSha256` rather than guessed.

HBC98 (RN 0.85.3, Expo/`expo export`, matching `react-navigation-example`'s
own toolchain so the measurement in §5.6 is apples-to-apples): only **10 of
16** starter packages, all fetched from `react-navigation-example`'s own
already-resolved `node_modules` per this task's mid-session redirection to
"use the apps that are there as the seed" rather than hand-picking versions —
`@react-navigation/native`, `@react-navigation/stack`, `react-native-gesture-handler`,
`react-native-reanimated`, `react-native-screens`, `react-native-safe-area-context`,
`@react-native-async-storage/async-storage`, plus the three foundations
(react/react-native/toolchain-empty). `redux`/`react-redux`/`@reduxjs/toolkit`/
`axios`/`lodash`/`moment`/`dayjs`/`zustand`/`immer` are **not** in
`react-navigation-example`'s dependency tree, so building their HBC98 DBs
would need a second, separately-provisioned RN-0.85-era project — not done in
this task's time budget, flagged as follow-up (a straightforward repeat of
the HBC94 recipe against a v98 project once one exists for other purposes).

Since Expo's own CLI (`expo export`) has no custom-entry-file flag, each
single-package HBC98 bundle was produced by temporarily overwriting the
cloned `react-navigation/react-navigation` example app's `App.tsx` with a
one-line `require('<pkg>')` re-export, running `expo export --no-bytecode`,
restoring `App.tsx`, then compiling the resulting JS text with this repo's
own `tools/hermesc/v98` (not Expo's bundled hermesc, to keep hashes
comparable against everything else in this task's DB). `build-db.mjs`
documents this as the reason its `--bundler expo` path is not automated
end-to-end in this prototype (its file header explains why) — the
`--hbc-file` fast path was used for every HBC98 entry instead, with
provenance filled in from the fetched project's own `node_modules` metadata.

### 5.6 Measurements

**`rn-template-0.72`** (HBC94, committed fixture — expect react + react-native
only):

| Package | Tier | Exact% | Fuzzy% | Modules |
|---|---|---|---|---|
| `react-native@0.72.17` | High | 99.2% | 99.2% | 422/422 |
| `react@18.2.0` | High (module-anchored) | 50.0% | 53.1% | 2/3 |
| everything else (12 absent packages) | Low/None | ≤5.3% | ≤13.0% | 0/N |

424/435 Metro modules (97.5%) matched to a known package; the 11 unmatched
are the template's own `index.js`/`App.tsx`/app-name module — genuinely
first-party code, exactly the expected outcome, and a clean false-positive
control (`@react-navigation/stack` briefly surfaced at 0.1%/1 module before
the tier fix in §5.4 — correctly demoted to Medium after it, since 1 module
out of 511 is not "high confidence stack is present," and it plausibly isn't:
a generic small helper shared by coincidence, not evidence of the package).

**`react-navigation-example` (0.85.3, HBC98)** — fetched fresh
(`tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh`'s recipe,
run in scratch; same commit the pinned fixture's BUILD.md records,
`ab1319d`): 15,551 functions, 1,782 `__d()` modules.

| Package | Tier | Exact% | Fuzzy% | Modules |
|---|---|---|---|---|
| `@react-navigation/stack` | High | 74.1% | 85.7% | 590/826 |
| `react-native-gesture-handler` | High | 67.2% | 80.0% | 403/616 |
| `react-native-reanimated` | High | 64.1% | 77.9% | 292/479 |
| `react-native-foundation@0.85.3` | High | 68.3% | 74.3% | 348/472 |
| `@react-navigation/native` | High | 50.9% | 68.8% | 99/252 |
| `react-foundation@19.2.3` | High | 40.1% | 42.5% | 2/3 |
| `react-native-screens` | High (module-anchored) | 20.6% | 68.5% | 31/168 |
| `@react-native-async-storage/async-storage` | High (module-anchored) | 15.5% | 71.3% | 6/122 |
| `react-native-safe-area-context` | High (module-anchored) | 4.7% | 67.2% | 5/125 |

All 9 packages that are *actually in this app's dependency tree* were
recovered at High confidence; **1,014/1,782 modules (56.9%) matched to a
known package**; the largest unmatched modules (637, 621, 503 instructions,
15-53 nested closures each) are the example app's own showcase screens —
plausible first-party code, not evidence of a missed library (this app has
no `redux`/`axios`/etc. dependency, so their absence from the "matched"
column is correct, not a gap).

**Expensify/App (0.86.0, HBC98) — not measured, timed as instructed.** Per
the task's "large; time it": `npm_config_engine_strict=false npm ci
--ignore-scripts` (3,002 packages) took **~60s**. `react-native bundle
--max-workers 1` (the documented watchman-race workaround) then hit the
exact race `BUILD.md` describes (`Failed to get the SHA-1 for:
node_modules/react-native-worklets/.worklets/<id>.js`) on the **first**
attempt at **12s** in (cache-warm from a prior run). Three retries were
made, each preceded by `watchman watch-del-all` + a fresh
`watchman watch-project .` + a settle delay, the last also with
`--reset-cache`: attempt 2 failed identically at 12s (stale watch state);
attempt 3, with a genuinely cold cache, ran for **3 min 34s** of real Metro
transform work before hitting the identical error on a *different* generated
worklet file (`10978648262198.js` vs. the first attempt's
`11554788234375.js` — confirming it's a live race against
`react-native-worklets`' babel plugin writing new per-worklet files
*during* the transform pass, not a stale-cache artifact: watchman is
underwatching a directory Metro just started depending on mid-build, on
this sandbox's filesystem-event delivery specifically). Total time spent:
~5 minutes across three attempts, no successful bundle. Not root-caused
further or retried a fourth time within this task's budget — `BUILD.md`
already documents the underlying cause and workaround; what's new here is
that the workaround did not suffice in this environment even after a full
watchman re-crawl, which is itself worth recording. **Follow-up**: retry
with `--max-workers 1` *and* an explicit `watchman watch-project` performed
*before* `npm ci` (so the watch is live for the entire worklet-extraction
window, not just re-armed afterward), or pre-warm by running the Babel
worklets plugin once standalone before the first `bundle` invocation.

**hbc2js-local-corpus** (`~/hbc2js-local-corpus/apks/*.apk`, 6 APKs, never
copied into this repo — extracted to scratch, sizes/paths reported here only
per the task's instruction; note: `tools/extract-apk-bundle.sh`'s candidate-path
matching silently failed on every one of these six real APKs, root-caused to
a `set -o pipefail` + `grep -q` SIGPIPE interaction — the script's `unzip -Z1
| grep -qxF` pipeline reports the *piped writer's* SIGPIPE exit code, not
grep's success, whenever grep's `-q` closes the pipe early after finding its
match; extraction was done by hand with plain `unzip -p` instead for this
task's own measurement, and this bug is flagged here for whoever owns that
script next, since this task's ownership boundary is `tools/pkgsig/**` only):

| App | HBC ver | Functions | Modules | High-confidence packages (modules matched) |
|---|---|---|---|---|
| Bloomberg | 96 | 58,932 | 4,995 | react-redux (13/31), @reduxjs/toolkit (1/6), async-storage (2/6), react-native (84/422), gesture-handler (54/325), reanimated (38/248), nav-stack (70/511), nav-native (5/128), react (2/3) |
| Xbox | 96 | 59,278 | 6,435 | async-storage (6/6, 94.0% exact), react-redux (17/31), @reduxjs/toolkit (2/6), gesture-handler (125/325), nav-stack (207/511), reanimated (81/248), nav-native (63/128), react-native (146/422), react (2/3) |
| Teams — `hermes.android.bundle` (rn-common) | 96 | 4,736 | 482 | react-native (184/422, 48.3% exact), react (2/3, 43.8% exact) |
| Teams — (camera) | 96 | 1,388 | 209 | react-native (17/422) only — a small, mostly-native feature module |
| Teams — (org-chart) | 96 | 3,179 | 427 | react-native (27/422), @react-navigation/stack (6/511) |
| Discord | 98 | 120,522 | 17,037 | react-native-foundation (9/472), @react-navigation/{stack,native} (9/826, 4/252) — all at low double-digit-or-under % |
| Shopify | 98 | 97,752 | 25,439 | react-native-foundation (10/472), @react-navigation/{stack,native} (8/826, 4/252) — similarly low |
| Pinterest | — | — | — | no JS bundle in the APK at all (confirmed §2.5; not a React Native app, or a fully-native build) |

**Discord and Shopify are the important negative result of this section.**
Both are genuinely HBC98 (confirmed by header bytes, §2.5) and both *are*
React Native apps using react-navigation, yet their per-module attribution
rate is only **0.5%** (85/17,037) and **0.6%** (161/25,439) — dramatically
worse than Bloomberg/Xbox's HBC96 rates (17-30%+) despite this task's HBC98
signature set being *larger* and *newer* than the HBC96 one. Root cause:
this task's HBC98 `react-native-foundation`/`@react-navigation/*` DBs were
built from **RN 0.85.3 / react-navigation 8.0.0-alpha** (`react-navigation-example`'s
own current versions, 2026-era), but Discord/Shopify's actual `.hbc` files
are almost certainly from a considerably **older** RN release that happens
to still tag its bytecode "version 98" — `docs/HBC-FORMAT.md`'s own
documented v98 header-layout/opcode-table ambiguity (two distinct real
layouts share the number) is exactly this problem one level up: **the HBC
version number is not a proxy for "which react-native source version,"
even approximately**, once the gap is more than a year or so. This is a
sharper, corpus-validated restatement of §3.3's "version pinning" design
principle — a signature DB keyed only by HBC version, without a matching RN
version close to the target's actual one, will silently under-match on a
real, older app. Not a pipeline bug; a coverage gap this task's time budget
didn't allow closing (would need a second HBC98-era project pinned to
an RN version contemporaneous with Discord/Shopify's actual build, which
requires knowing or guessing that version — itself research, not measurement).

No HBC94/96/98 DB exists for a package genuinely absent from all six apps to
serve as a clean single-app false-positive probe the way §2.2's `lodash`
did for the single-fixture case, but the **within-corpus** cross-check is
itself informative: `lodash`'s only hit on any of these six apps is Xbox, at
28.7% exact — and Xbox's `lodash` DB has exactly 1 eligible function after
the `--min-instr 8` floor, so that "28.7%" is one single function matching,
not real evidence of lodash (correctly surfaced as "Low" tier, not
"High" — the tier-fix in §5.4 is exactly what keeps a 1-function coincidence
from reading as a confident match). Teams' three feature bundles (each a
separate `hermes.android.bundle` — Teams ships micro-frontends, §2.5) show
successively weaker, plausible signal as they get smaller and more
special-purpose (camera capture, org chart) — exactly the pattern a
real, non-cherry-picked corpus should produce.

### 5.7 What the D17 emitter pass needs from M4's output

Per D17's text and this task's own measured findings, the emitter pass
(owned by the M4 decompiler agent, not implemented here) needs, per Metro
module recovered from the target bundle:

1. **The `dscan.mjs`-shaped module graph already, not re-derived**: factory
   function index, local module id, and the ordered `depIds` array. D17
   should not re-implement §3.1's `__d()` pattern scan inside `src/**` from
   scratch — `tools/pkgsig/lib/dscan.mjs` is small, dependency-light (only
   `src/parse/buffers.ts`'s already-exported `readLiterals`), and could be
   promoted into `src/**` verbatim by M4 if useful there, or D17 can shell
   out to `tools/pkgsig`'s fingerprinting as a build step and just consume
   its module-graph JSON.
2. **A per-function exact/fuzzy hash pair it can compute itself** on M4's own
   decoded/normalised function representation, so D17 doesn't need to
   reimplement `sig-normalise.mjs`'s masking either — or, cleaner, M4 exposes
   a hook so `sig-normalise.mjs`'s dependency-index-masking logic can run as
   a documented *variant* of `normaliseFunction` inside `src/**` itself
   (this task deliberately did not touch `src/**`, per the ownership split,
   but the fix is small — ~60 lines, §5.1 — and D17 will want it available
   without importing across the `tools/`/`src/` boundary at decompile time).
3. **The confidence tier this task's `match.mjs` computes**, or the
   ingredients to compute it identically (module-exact-hit count, module
   total, function-level exact/fuzzy coverage) — D17's own emission rule
   (§3.4, unchanged by this task) is: High ⇒ emit `require("pkg")` only
   after the round-trip re-bundle-and-diff check D17's spec already requires;
   Medium ⇒ comment annotation only, never a code substitution; Low/None ⇒
   ignore. This task's tier revision (§5.4) — requiring several independent
   module hits, not just one — should be carried into D17's own threshold
   directly, since it was found to matter on real production bundles, not
   just synthetic ones.
4. **A place to file "package present, version ambiguous"**: not
   encountered in this task's own measurements (every High match happened to
   have a single, obviously-correct in-tree version to compare against), but
   §4's risk S3 remains open and unmeasured — D17 should not assume
   `match.mjs`'s top-ranked version is unique just because this task's
   fixtures never exercised the ambiguous case.

### 5.8 Remaining blockers / follow-ups

- **S1 (require-immediate), revised**: the masking fix (§5.1) is implemented,
  correct for the pattern it targets, and measurably improves `react`'s
  exact rate — but is **not** the dominant cause of `react`'s residual
  function-level gap, which remains unexplained at the single-function level
  (§5.1's negative result). Whole-module anchoring (§3.1) already routes
  around this for the cases measured here (2/3 and 422/422 module-exact
  hits), so it is not currently blocking D17's own architecture, but the
  root cause is worth another pass before trusting function-level percentages
  as a primary signal for any package smaller than react-native.
- **S2 (toolchain-baseline staleness), confirmed and extended**: §5.2 found
  the baseline is bundler-shaped, not just (RN, Hermes)-version-shaped
  (Expo's empty baseline is 414 functions vs. plain RN-CLI's 75, same Hermes
  bytecode version). A production signature-DB service needs one baseline
  per (bundler, bundler version, RN version, Hermes version) tuple, a
  materially larger axis than §3.3 anticipated.
- **HBC98 starter-set coverage is partial** (§5.5): 10/16 packages, missing
  redux/react-redux/@reduxjs-toolkit/axios/lodash/moment/dayjs/zustand/immer
  at HBC98 specifically (all 16 exist at HBC94/HBC96). Needs a second
  Expo-or-RN-CLI project pinned to an HBC98-era RN version with those
  packages added.
- **Expensify measurement did not complete** — §5.6's three-attempt log:
  Metro's bundling step hit the `react-native-worklets` watchman race
  `BUILD.md` already documents, and did not clear it even after a full
  `watchman watch-del-all`/`watch-project` re-crawl and `--reset-cache` on
  the third attempt (which ran 3m34s of real transform work before hitting
  the identical error on a different generated file). Reproduce with
  `tests/fixtures/bundles/expensify-app-0.86.0/fetch.sh`; the follow-up
  ideas in §5.6 (watch the project *before* `npm ci`, or pre-warm the
  worklets plugin once standalone first) are untried.
- **Discord/Shopify (real APKs) attribute under 1% of modules** (§5.6) —
  root-caused to an HBC-version-vs-RN-source-version mismatch (this task's
  HBC98 signature set is ~2026-era RN/react-navigation; those apps' actual
  bytecode is evidently from a considerably older release that also tags
  itself "v98"). Confirms §3.3's version-pinning principle matters more than
  the HBC major-version bucket alone once the gap is more than ~a year.
- **`tools/extract-apk-bundle.sh` bug** (§5.6): the `pipefail`/`grep -q`
  SIGPIPE issue causes it to report "no bundle found" on every real APK
  tested (6/6) despite every Hermes-shipping one actually having a bundle at
  exactly the path it checks first. Not fixed here (outside this task's
  `tools/pkgsig/**` ownership) — flagged for whoever owns it; the fix is
  either `grep -qxF ... || true` on the reader side or restructuring to
  avoid a pipeline under `pipefail` with an early-exiting consumer.
- **Version-ambiguity (S3, §4)** remains completely unmeasured — no fixture
  or corpus app in this task exercised two candidate versions with identical
  matched hashes.

## 6. D17c bulk build: first check-in and coverage measurement (2026-08-30)

Check-in on the bulk build D17c kicked off on `deb` (STATUS.md), plus
assembling and measuring what exists so far. `tools/pkgsig/bulk/**` scripts
only — no `src/**` touched.

### 6.1 Progress at check-in

At 2026-08-30 15:54 UTC (run started 10:56 UTC, ~5h in): **23,046/53,276
jobs processed (43.3%)**, ok=15,727, fail=7,319 (31.8% fail rate — see §6.2,
this is expected, not a health problem), ~77 jobs/min, **ETA ~22:20-22:30
UTC same day** (~6.5 h more). Process alive (checked via its recorded pid,
not restarted). DB on disk: **3.1 GB** raw across 15,728 signature files;
host disk has 85 GB free (91% used) — enough headroom for the run to finish.

### 6.2 Failure classes (7,319 failures, sampled by parsing `results.jsonl`)

All failures fall into the three classes STATUS.md already called out as
expected, plus one new transient class worth naming:

| Class | Count | Example |
|---|---|---|
| Package is Node-only / not RN-bundlable — `require("fs")`/`"path"`/`"crypto"`/`"stream"`/`"util"`/`"process"`/deep internal submodule paths (e.g. `core-js`'s `../modules/esnext.iterator.zip`) that Metro can't resolve in an RN scaffold | ~5,900 | `fast-json-stringify` → `Unable to resolve module crypto` |
| Unresolved peer dependency — package needs a peer (`expo-modules-core`, `@react-navigation/native`, `react-native-svg`, `reanimated`, `safe-area-context`, `gesture-handler`, `@react-native-firebase/*`, `graphql`, …) the bare scaffold doesn't have installed | (counted within the above — `expo-modules-core` alone: 702) | `expo-file-system` → `Unable to resolve module expo-modules-core` |
| Self-fingerprinting `react-native`/`react-dom` against a scaffold already pinned to a different version of the same package | 916 | `react-native@0.83.1` bundle fails inside the RN-0.72.17-pinned scaffold |
| **New: transient `ENOBUFS` from `hermesc`** under sustained 16-way load (~150 occurrences) — not a build bug, a resource-exhaustion hiccup; the job is simply missing from the DB and gets silently retried by the *next* `run.sh start` invocation (resumable, per-file skip) | ~150 | `spawnSync .../hermesc ENOBUFS` |

No unexpected failure class found. Nothing here indicates the run should be
restarted — `run.sh` is still alive and making progress; missing jobs
(including the `ENOBUFS` ones) are automatically picked up whenever `start`
is next invoked, since `build-one.mjs` skips anything already on disk.

### 6.3 Assembler: `tools/pkgsig/bulk/assemble.sh`

New script, idempotent and safe to run while the build continues (a file
`writeSignature()` is mid-writing simply fails `JSON.parse` and is skipped —
picked up on the next run). One pass hashes+sizes every `db/*.json` (except
`index.json`, `src/deps/db.ts`'s own flat manifest) with a single Node
process (sha256 while already holding the bytes, no `sha256sum` fork per
file), writing:

- `~/hbc2js-bulk/dist/index.json` (+ a dated copy) — nested
  `package → version → hbcVersion → {file, size, sha256, totalFunctions,
  rawFunctionCount, moduleCount, toolchainBaseline, subtractedBaselines,
  provenance}`, plus top-level `totalFiles`/`totalBytes`/
  `skippedUnreadableOrPartial`.
- `~/hbc2js-bulk/dist/sigdb-<YYYYMMDD>-partial.tar.zst` — flat archive of
  every successfully-indexed signature file (basenames only, matching
  `index.json`'s `file` field) plus a copy of `index.json` at the archive
  root for self-description. `zstd` preferred (present on `deb`), `--gzip`
  flag falls back to `.tar.gz`. Publish is a same-filesystem `mv` into the
  final name, so a concurrent fetcher never sees a half-written archive.

First run (15,420 files): **29 s, archive 348 MB** (3.1 GB raw db/, ~9:1
compression). Re-run 3 minutes later while the build kept going picked up
58 more files with zero errors, confirming the idempotent/live-build claim.

### 6.4 Coverage measurement — and an important negative result

Per the brief: no proprietary bundle ever left this machine or was copied
onto `deb`. The two apps checked are our own (committed fixture / fetched
via `fetch.sh`): `rn-template-0.72` (HBC94) and
`react-navigation-example-0.85.3` (HBC98). The current partial archive was
`scp`'d back (348 MB) and extracted locally; `hbc2js deps --offline` was run
three ways per app: shared DB only (today's `docs/DEPS.md` baseline,
re-measured fresh rather than trusted from the doc), shared DB + the bulk
DB layered in via `--sigdb`, and bulk DB alone (`--no-shared-db --sigdb`) to
isolate its own signal.

| App | Shared-DB-only (module attribution) | + bulk DB layered in | Bulk DB alone |
|---|---|---|---|
| `rn-template-0.72` | 97.7% (425/435) | 97.9% (426/435) | — |
| `react-navigation-example-0.85.3` | 57.8% (1030/1782) | 57.6% (1025/1782) | 5.0% (78/1782), yet 1,027 packages in `confirmedDeps` |

**Module-attribution % barely moves — and for react-navigation-example it
goes slightly backward.** The real finding is in `confirmedDeps`: layering
the raw bulk DB in ballooned the confirmed-package list from a handful of
genuine dependencies to **thousands of entries**, most obviously wrong
(`pg-int8`, `postgres-bytea`, `text-hex`, `merge-descriptors`, `lucide-react`
at three unrelated versions, `one-time`, `is-negative-zero`, …) — small,
generic utility packages that could not plausibly be real dependencies of
either app.

**Root cause: `tools/pkgsig/bulk/build-one.mjs` never runs the
foundation-subtraction step §5.2 describes.** The curated shared DB
(`tools/pkgsig/build-db.mjs`) subtracts `metro-toolchain-empty` +
`react-foundation` + `react-native-foundation`'s function hashes from every
package before writing it; the bulk builder (by design — see its own header
comment, and D17c/STATUS's framing as "populate the shared DB
unconditionally, there is no target yet") writes each package's **raw**
signature, including a full, unsubtracted copy of every react-native/Metro
boilerplate function the scaffold happens to share with everything else.
With ~15,000 files each independently carrying that same boilerplate, a
target app's ordinary Metro/react-native scaffolding functions collide
against thousands of unrelated bulk-built packages simultaneously, and (at
least for whole-package tiers like ">=90% overall exact-function coverage")
enough of those collisions clear "High" confidence on packages that only
ever contributed a handful of functions to their own signature file in the
first place. `--no-shared-db` alone shows this starkly: 1,027 "confirmed"
packages from a DB that only actually explains 5% of the target's modules.

**Conclusion for whoever runs the next step of D17c: do not fetch/layer
this partial archive into a real `--sigdb` today.** It needs foundation
subtraction (§5.2) applied — either as a post-process over the existing
`db/` directory (subtract `react-foundation`/`react-native-foundation`/
`metro-toolchain-empty`'s hash sets from every file already written, cheap
and doesn't require re-running any job) or built into `build-one.mjs` for
everything built from here on — before republishing. This is a data-quality
gate, not a code bug in `assemble.sh`/`run.sh` themselves, which did exactly
what they were asked to (package and measure what exists).

### 6.5 Fetching the archive later

`tools/pkgsig/fetch-db.sh` (new stub): `HBC2JS_SIGDB_URL=<url>
tools/pkgsig/fetch-db.sh [dest-dir]` downloads and unpacks a published
`sigdb-*.tar.zst`/`.tar.gz` into `dest-dir` (default
`$XDG_CACHE_HOME/hbc2js/sigdb`, the same user-cache layer `hbc2js deps`
already reads — docs/DEPS.md). No URL is published yet — `HBC2JS_SIGDB_URL`
has no default; today's archive lives only at
`deb:~/hbc2js-bulk/dist/sigdb-20260830-partial.tar.zst` and, per §6.4,
should not be treated as ready for real use until subtracted.

### 6.6 The D17c fix: foundation subtraction in `build-one.mjs`, and a second, separate false-positive class found while validating it (2026-08-30)

Follow-up to §6.4's "do not fetch this archive" finding. `tools/pkgsig/bulk/**`
scripts only — no `src/**` touched, per this task's ownership split.

#### 6.6.1 Root cause, confirmed precisely

Neither `src/deps/confirm.ts` (the promoted `--confirm` stage) nor the old
`build-one.mjs` ever calls a baseline-subtraction routine — none exists as
an importable `src/deps` export today. The checked-in
`tools/pkgsig/db/*.json` starter files (e.g. `redux@4.2.1__hbc94.json`:
`rawFunctionCount: 124`, `totalFunctions: 36`, `subtractedBaselines` listing
3 files) were produced by the pre-promotion prototype `build-db.mjs`
(`tools/pkgsig/README.md`'s own mapping table), whose subtraction step was
never carried into the typed pipeline. So "reuse `src/deps`'s exported
function" (this task's plan A) was not available; the logic is ported
locally instead, scoped to `tools/pkgsig/bulk/**`.

#### 6.6.2 The fix

- **`tools/pkgsig/bulk/baseline-subtract.mjs`** (new): `computeBaselineUnion(dbDir,
  hbcVersion)` unions the `exactHash` sets of every `_baselines/*__hbc<N>.json`
  file for that HBC version; `subtractBaseline(rawFunctions, rawModules,
  hashes)` filters functions and flags `factoryIsBaseline` on modules — the
  same two operations the curated `redux@4.2.1__hbc94.json` file's shape
  implies. **`tools/pkgsig/bulk/test-baseline-subtract.mjs`** (new,
  network/build-free) reconstructs a "raw" function set from that real
  checked-in file's own 36 surviving functions plus the real, checked-in
  baseline files' functions, and asserts `subtractBaseline` reproduces the
  fixture's exact `exactHash` set and `factoryIsBaseline` flags exactly —
  passes locally and on `deb`.
- **`build-one.mjs`**: calls the above after `fingerprintModule`, writes
  `subtractedBaselines`/`rawFunctionCount`/`totalFunctions` correctly, and
  stamps every written file with **`bulkBuildFixVersion: 1`** (a marker,
  not part of the canonical `SigDbFile` schema — extra JSON keys are
  harmless to existing readers) so a fixed file can be told apart from a
  pre-fix one. If the (RN, hbc)'s baseline set isn't complete yet, **the job
  fails loudly** rather than silently writing unsubtracted data under the
  "fixed" marker — verified live: 603 jobs failed with `"incomplete
  baseline set"` during the ~6-minute window before baselines existed for
  hbc96, self-healing on the next `run.sh start`.
- **Workers load `build-one.mjs` fresh per job** (`worker.sh` invokes
  `node build-one.mjs ...` per line, no long-lived cache) — confirmed live:
  the very next jobs after deploying the patched file already showed
  `"functions":36,"rawFunctions":121"`-style output, no worker restart
  needed.
- **`tools/pkgsig/bulk/build-baselines.mjs`** (new) + **`run.sh baselines`**:
  regenerates the 3 baseline "packages" (`metro-toolchain-empty`,
  `react-foundation`, `react-native-foundation`) for a given scaffold/HBC
  pair from that scaffold's **own** installed versions — never hand-picked.
  This mattered in practice: the repo's checked-in HBC98 baselines were
  built from RN 0.85.3/metro 0.83 (§5's earlier measurement fixture), but
  the bulk build's actual `ScaffoldRN87` is **RN 0.87.1/metro 0.87.0** —
  exactly the §4 S2 "toolchain-baseline staleness" risk, found for real.
  No baseline at all existed for HBC99. All 12 (3 kinds × {hbc94, hbc96,
  hbc98, hbc99}) were regenerated fresh from the live scaffolds on `deb`
  (`react-native-foundation@0.87.1`, `metro-toolchain-empty@0.87.0` for
  hbc98/99; the RN72-family baselines matched the existing hbc94/96 ones
  exactly, since `ScaffoldRN72` is the same RN 0.72.17 §5 used). First
  attempt raced the live build over the shared scaffold slot (an `ENOENT`
  metro-cache collision + an `npx` timeout) — `run.sh baselines` now claims
  the same `flock` lock file `worker.sh` uses before touching a slot.
- **`--refingerprint` mode + hbc-cache**: `build-one.mjs --refingerprint`
  bypasses the "already on disk → skip" gate and, when a cached compiled
  `.hbc` exists at `<db>/../hbc-cache/`, re-fingerprints from it with no
  re-download/re-bundle/re-compile; every successful compile (fresh or
  refingerprint) now populates that cache. **Caveat found**: the pre-fix
  `build-one.mjs` never cached `.hbc` output (deleted with its temp dir), so
  the ~17k already-built entries have no cache hit on their *first*
  refingerprint pass — that pass necessarily does a full rebuild for each
  (same cost as the original build), but populates the cache for next time.
  **`run.sh refingerprint`** builds its job list from `db/*.json` missing
  `bulkBuildFixVersion`, runs it through **`refingerprint-worker.sh`** (same
  flock-protected slot semaphore as `worker.sh`, logs to
  `log/refingerprint-results.jsonl` — never `results.jsonl`) — safe
  alongside a live `start` (disjoint job sets: `start` only builds what
  isn't on disk, `refingerprint` only touches what is).
- **`assemble.sh --fixed-only`**: excludes any entry without
  `bulkBuildFixVersion: 1` (counted separately as `excludedUnfixed` in
  `index.json`, not lumped into `skippedUnreadableOrPartial`); output is
  named `sigdb-<date>-fixed.tar.zst` / `index-fixed.json` (a plain run keeps
  `-partial.tar.zst` / `index-partial.json`) so the two archive kinds are
  never confused.

#### 6.6.3 Validation: re-measured on both fixtures, from a fixed-only sample

Deployed to `deb`, baselines regenerated (verified: `run.sh
refingerprint`'s very next jobs showed correct subtraction), then
`refingerprint` launched under `nohup` (not waited on — see §6.1.4).
Rather than wait hours for the full 16,955-entry backlog, 20 packages were
fast-tracked via `refingerprint-worker.sh` directly: the 6 named
false-positive examples from §6.4 (`pg-int8`, `postgres-bytea`, `text-hex`,
`merge-descriptors`, `one-time`, `is-negative-zero`) plus `lucide-react`,
each at hbc94 and/or hbc98 — all dropped from ~58-84 raw functions to 2-6
kept, exactly the expected boilerplate-collapse. `assemble.sh --fixed-only`
then packaged **1,331 already-fixed files** (of ~18.4k on disk at the time)
into `sigdb-20260830-fixed.tar.zst`, `scp`'d back and extracted locally
(no proprietary bundle touched `deb` or left it — same rule as §6.4).
`hbc2js deps --offline` run three ways per fixture (shared-only, +bulk
fixed layered, bulk fixed alone):

| App | Shared-only | + bulk fixed layered | Bulk fixed alone |
|---|---|---|---|
| `rn-template-0.72` | 424/435 modules, 2 confirmedDeps (react, react-native) | **424/435 modules, 2 confirmedDeps — byte-identical** | 0/435 modules, **0 confirmedDeps** |
| `react-navigation-example-0.85.3` | 1014/1782 modules, **9/9 confirmedDeps, all real** | 1009/1782 modules, 17 confirmedDeps | 34/1782 modules, 9 confirmedDeps (0 real — sample-coverage artifact, see below) |

**`rn-template`: full acceptance met, 0 false positives.** Layering the
fixed bulk sample in changes nothing — same 2 confirmed packages, same
module count. None of §6.4's named false-positive examples (nor any other
bulk package) appear.

**`react-navigation-example`: the named §6.4 bug is fixed, but a second,
separate false-positive source was found while checking.** None of
`pg-int8`/`postgres-bytea`/`text-hex`/`merge-descriptors`/`one-time`/
`is-negative-zero`/`lucide-react` appear anywhere in the layered result —
the boilerplate-collision class this task targets is gone, and all 9 real
dependencies are still recovered at High confidence with their exact
module-hit counts unchanged from §5's own measurement (recall preserved).
But 8 of the 17 layered `confirmedDeps` are still wrong: `js-md5` (5 built
versions) and `@emotion/react` (3 built versions) clear `match.ts`'s "high"
tier from a **single coincidentally-matching module** each (`js-md5`:
1/2 non-baseline modules = 50% coverage; `@emotion/react`: 1/16-17 ≈ 6%) —
`scorePackage`'s own `strongModuleSignal = moduleExactHits >= 3 ||
(moduleExactHits >= 1 && moduleCoverage >= 0.05)` threshold (§3.4) is lenient
exactly for packages with very few total modules, and neither package is
anywhere near react/react-native/Metro boilerplate — this is a **different,
pre-existing root cause** (generic small-module/barrel-file collision +
a tier-threshold design gap already flagged in §3.4/§4 S3, and partially
addressed once before per §5.4's "briefly surfaced... demoted to Medium"
note for a different package), in `src/deps/match.ts`, not
`tools/pkgsig/bulk/build-one.mjs` — **out of this task's ownership**, not
fixed here, flagged as a follow-up for whoever owns `src/deps/match.ts`
next. (A 9th wrong entry, `@react-navigation/native@7.3.18` alongside the
correct `8.0.0-alpha.44`, is §4 S3's already-documented "wrong version of a
real package" risk, not a new package-level false positive.) The
bulk-fixed-alone row's "9 confirmedDeps, 0 real" is a **sample-coverage
artifact, not a regression**: `packages.json`'s chosen versions for the 7
real dependencies (e.g. `@react-navigation/stack` 6.3.10-7.10.24) never
happen to include the fixture's actual pinned `8.0.0-alpha.53` etc., so
bulk-alone can't recall them by exact-version key regardless of
subtraction — recall for this fixture comes entirely from the shared
curated DB (§5), which this fix never touches.

**Conclusion**: D17c's specific bug (unsubtracted shared boilerplate causing
thousands of false confirms) is fixed and validated — full 0-false-positive
acceptance on `rn-template`, and the named §6.4 examples eliminated on
`react-navigation-example` with recall preserved, but that fixture does not
yet clear D17d's confirmed-tier-FP=0 bar outright because of the
independently-discovered `match.ts` tier-threshold gap above.

#### 6.6.4 Refingerprint progress

Launched under `nohup` on `deb`, not waited on (per this task's instruction).
At check-in: **443/16,955 processed (2.6%), ok=401 fail=42** (same expected
failure classes as §6.2, including a new `metro-cache` `ENOENT` under the
now-doubled slot contention from running alongside the live build — same
self-healing tolerance), running alongside the live main build (which was at
53.4% (28,472/53,276) at the same check-in). Both share the same 16
`flock`-protected scaffold slots, so each is currently getting roughly half
the machine; once the main build finishes (§6.1's ETA of ~22:20-22:30 UTC
same day still holds, hours away at this check-in), refingerprint gets the
full slot pool and should accelerate substantially. Rough ETA for full
refingerprint
completion: several hours after the main build finishes — check with `ssh
deb '~/hbc2js/tools/pkgsig/bulk/run.sh refingerprint-status'`. Do not fetch
or re-assemble a "final" archive until `refingerprint-status` reports the
backlog at or near 0 (or accept a `--fixed-only` partial sample, as this
task did).
