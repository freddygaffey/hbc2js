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
