# Architecture decisions

Numbered; never delete, mark superseded instead.

## D1 — Language: TypeScript on Node (2026-08-30)
Output is JS and the harness executes JS, so a TS toolchain removes a subprocess boundary. Python was considered and rejected for that reason. hermes-dec (Python, pip-installed) remains available as an external oracle.

## D2 — Semantic equivalence is defined by a trace, run in a sandbox (2026-08-30)
Fixtures call nondeterministic/host APIs (`Math.random`, `Date.now`, `print`, `alert`, `window`). The harness runs both original and decompiled JS in a `node:vm` context with:
- stubbed `print`/`alert`/`window`/`console.*` that append to an ordered trace
- seeded `Math.random`, frozen `Date.now`
- captured thrown errors (message + constructor name), promise settlements, and generator sequences
Equivalence = identical trace. The trace format lives in `docs/TESTING.md` once the harness exists.

## D3 — Round-trip recompilation is the scalable correctness oracle (2026-08-30)
Real RN bundles cannot execute in Node. For them, correctness is checked by: decompile → recompile with `hermesc` → disassemble both → structural diff (normalising register/label names). Supplemented by diffing our disassembler against hermes-dec's. Execution-trace tests (D2) apply only to pure-JS fixtures.

## D4 — Licensing policy (2026-08-30)
hermes-dec is AGPL: read its output, never its code. Hermes itself is MIT: opcode/operand definitions may be derived from it. Test corpus apps must be MIT/Apache/BSD/ISC; licence recorded per fixture.

## D5 — Agent model policy (2026-08-30)
Fable oversees only. An Opus "architect" agent writes specs for each component; implementation goes to Opus for the decompiler core (CFG, structurer, emitter) and Sonnet for parsers, tooling, tests, research. Constraint: stay within plan limits, never usage credits.

## D6 — Irreducible control flow falls back to `for(;;) switch(ip)` (from SPEC)
Guaranteed-correct emulation; structure recovery is applied wherever it is provably safe.

## D7 — Structurer core: Ramsey (ICFP'22) recursive CFG→structured translation; supersedes D6 (2026-08-30)
Total algorithm (no irreducibility test), emits labelled blocks + `while(true)` + multi-level `break` that map 1:1 onto JS. Readability rewrites (`while(c)`, `for`, `switch`, early-return flattening) are separate, individually testable AST passes. Exception regions are carved from the handler table *before* structuring; exception edges never enter dominator computation. See docs/PRIOR-ART.md.

## D8 — Parser probes the layout; it never trusts the version field alone (2026-08-30)
Verified from bytes: v98 exists in two header layouts and v99 in two opcode tables without a version bump. Opcode/layout tables are generated per Hermes commit SHA from MIT sources, and the parser selects them by structural probing plus version. Silent misdecode is risk R1.

## D9 — v97+ generators/async get a runtime shim first (2026-08-30)
Static Hermes removed the generator opcodes; bodies are compiler-lowered state machines. v1 emits `__hbc_makeGenerator(body, env)` as the provably-correct floor; `yield` recovery is v2. Pre-v97 keeps opcode-driven generator recovery.

## D10 — Fixture corpus must exercise every table before M4 (2026-08-30)
Literal buffers, object shape table, BigInt table and switch jump tables are empty in all original fixtures (R5). `tests/fixtures/constructs/` compiled with and without `-O`/`-g`, plus one real Metro bundle, are prerequisites for the emitter.

## D11 — Incremental, fixture-driven development (2026-08-30)
Build the baseline first (parser → disassembler → CFG → Ramsey structurer → emitter with the D9 shim), until *every* fixture decompiles to JS that passes the equivalence checker — ugly output is fine at this stage. Then iterate one construct at a time: pick the next `tests/fixtures/constructs/<NN-topic>`, add a targeted recovery pass (e.g. `while(c)`, `for-of`, `switch`, closure naming), with the fixture as its red→green test, and the full corpus as the regression gate. Each pass is its own module under `src/passes/`, individually testable and toggleable. Order of passes follows the fixture numbering unless a dependency forces otherwise. The equivalence checker never regresses: a pass that improves readability but breaks any fixture is rejected.

## D12 — Every recovery pass is matcher + writer + checker, catalogued (2026-08-30)
Each pass under `src/passes/<name>/` exports a pure `match(node, ctx) → Match | null` (recognises one Hermes lowering idiom, never mutates), a `rewrite(match) → node` (emits the idiomatic JS for exactly the captured shape), and a local `check(before, after)` (asserts the rewritten subtree preserves control-flow entry/exit edges; failure aborts the pass for that site and leaves the correct-but-ugly form). `docs/LOWERING-CATALOGUE.md` lists every idiom with its matcher, writer, and the fixture that exercises it; adding a construct = one catalogue row, one fixture, one pass directory. The full-corpus equivalence run is the regression gate for every pass.

## D13 — Test tiers by cost (2026-08-30)
- **Gate** (every commit, seconds): `tests/fixtures/constructs/**` + `hermes-dec-sample` through parser/disasm goldens and the equivalence checker.
- **Sweep** (nightly/on demand, minutes): harvested Hermes lit tests, test262/quickjs subsets, Tier 2 bundles via recompile round-trip (D3).
- **Hardened** (after the gate passes): obfuscated variants of gate fixtures (`javascript-obfuscator`: control-flow flattening, string-array encoding, dead code) — these change CFG shape, unlike minification, which Hermes already erases. Minified variants are kept only as a control proving name-erasure. See tests/fixtures/OBFUSCATION.md.
New gate fixtures must be the red→green test for a pass or a minimised regression from a sweep failure; bulk corpora never enter the gate.

## D14 — Ground truth is the Hermes VM running the original `.hbc`, not Node running the source (2026-08-30)
Hermes diverges from spec/Node on per-iteration `let`, TDZ with shadowing, and sloppy `arguments` aliasing, and does so at every version tested (84, 89). The decompiler must reproduce the bytecode's behaviour. Therefore: where a Hermes VM for the fixture's version exists, its trace is the reference; `expected.txt` (Node) is the reference only when no VM is available and the fixture is not in the known-divergence set. Building Hermes from source for v94/v99 VMs is a sanctioned toolchain task (`hermes-engine-cli` stops at HBC 89).

## D15 — Equivalence verdicts are three-valued; oracle ladder cheapest-first (2026-08-30)
`node --check` → trace equivalence (D2) → differential fuzzing of exports → recompile round-trip (D3). PASS / DIVERGENT / INCONCLUSIVE; INCONCLUSIVE (timeout, empty trace, missing oracle) never counts as PASS. Round-trip similarity is a per-function ratchet, not a global percentage, because one extra instruction cascades through register allocation. See docs/EQUIVALENCE.md; `tools/equiv/` is the reference implementation to be promoted into `src/harness/`.

## D16 — Test corpus categories (2026-08-30)
Supersedes the tier list in D13 with an explicit taxonomy; each category has its own directory under `tests/fixtures/`, its own oracle set (D15), and its own place in CI (gate vs sweep).

| Category | Dir | Source available | Oracles | CI |
|---|---|---|---|---|
| C1 Constructs | `constructs/` | yes | trace (Hermes VM per D14, else Node), fuzz, round-trip | gate |
| C2 Construct variants | `constructs/*/source.{obf,min}.js` | yes | same as C1 | gate (min), sweep (obf) |
| C3 Open-source RN apps | `bundles/<app>-<rn>/` | yes (MIT/BSD/Apache) | round-trip, `node --check`, disassembly diff | sweep |
| C4 Hardened builds of C3 | `bundles/<app>-<rn>/hardened/` | yes | same as C3 | sweep |
| C5 Proprietary APK bundles | `local-corpus/` (gitignored) | **no** | parse, `node --check`, round-trip only | sweep, skipped as INCONCLUSIVE when absent |

C5 rules: never commit the bundles or anything derived from them; `tools/extract-apk-bundle.sh <apk>` extracts `assets/index.android.bundle`, records sha256 + Hermes version into `local-corpus/MANIFEST.json` (which *is* committed, hashes only). Only APKs the user has legitimately obtained; analysis is local. C4 is produced by `tests/fixtures/build.sh --variants` with the D13 obfuscator config.

## D13a — Hardened-tier caveat (2026-08-30)
T3 found `hermesc` (even `-O0`) collapses javascript-obfuscator's `while(true){switch(ip)}` dispatcher back to linear code when the state index is compile-time derivable, so control-flow flattening is partly undone before we see it. The obfuscated tier still stresses string-array decoding, dead-code, and split strings; genuinely irreducible-CFG stress must come from hand-built fixtures or from computed-state obfuscation (`ip` derived from runtime values). Track under T-hardened on the task board.

## D17 — npm package recognition via bytecode signatures (planned, post-baseline) (2026-08-30)
Metro preserves module boundaries (`__d(fn, id, deps)`) and `hermesc` is deterministic, so known npm packages can be recognised by fingerprinting normalised function bytecode (FLIRT/Function-ID style) built offline by bundling curated package versions with matching Metro + hermesc. A high-confidence whole-module match is emitted as `require("<pkg>")` plus a dependency entry; partial matches are annotated, never silently replaced. Implemented as a D12 pass with a checker that re-bundles the replacement and confirms bytecode equality. Depends on M1–M2 and the D3 normaliser; scheduled after the M4 baseline.

## D18 — Multi-frontend architecture (planned) (2026-08-30)
Format-specific: parser, disassembler, CFG builder, lowering catalogue. Format-independent: structurer, emitter, pass framework, harness. Keep the boundary explicit as a `Frontend` interface (`bytes → { cfg per function, tables, version info, runtime-semantics profile }`) so additional inputs can be added without touching the generic layers. Candidate frontends, by payoff: (1) plain-JS bundles — Metro/Expo without Hermes, and **Capacitor/Cordova/Ionic** web builds (`assets/public/`, webpack/Vite chunks): no decompilation; un-bundling via reusable tools (webcrack MIT, wakaru Apache-2.0), then D17 package recognition on minified JS and D19 project-tree/screens output with router-based route discovery; (2) V8 bytecode from Electron/Node (`bytenode` `.jsc`) — new audience, version-fragile, trace oracle only; (3) QuickJS bytecode. Not pursued until M5 is underway on Hermes. **Amended 2026-08-30 (issue #2):** at M4 the boundary is intent, not an invariant — the emitter reads `HbcModule` directly by design. Building the `Frontend` seam is the **first M6 task**, before project-tree output, and is not a prerequisite for M5 passes (which operate on the tree IR, above the seam).

## D17a — The signature DB is a cache; unknown modules are guessed then confirmed via npm (2026-08-30)
Matching is two-stage. (1) **Guess**: for each unmatched Metro module, derive candidate `package@version`s from evidence, each clue weighted: native-module registrations (`NativeModules.X` / `TurboModuleRegistry.get('X')` names map near-uniquely to npm packages); APK-side evidence when the APK is available (manifest permissions such as `BILLING`, bundled `.so` names, Gradle-generated package classes, `google-services.json`); string constants (package names in error/warning prefixes, `displayName`s, version strings, URL/API-host constants, licence banners); Metro dependency edges to already-identified modules; function count/shape. Clues with no direct name go to (a) source code search on distinctive string constants — Sourcegraph/grep.app/GitHub index nearly all npm package sources and string literals survive compilation unchanged — and (b) registry dependency inference (packages depended on by an identified requirer and depending on an identified requiree); failing those, an npm registry search query (e.g. terms from a payment permission + a module name) whose top results are candidates; the confirm stage settles them. (2) **Confirm**: `npm pack` each candidate (exact version if evidenced, else nearest by publish date to the app's RN release), bundle + compile with the toolchain matched to the bundle's HBC version, fingerprint, match; on success store the signature in `tools/pkgsig/db/` so it's free next time. The curated starter set only seeds the cache. `hbc2js deps <bundle.hbc>` lists guessed and confirmed dependencies with confidence; `--confirm` performs the npm stage (network, opt-in). Never executes package code — only bundles it.

## D17c — Bulk-fingerprint the popular tail (planned) (2026-08-30)
npm has no function-level search, so precompute: the ~3,000 packages covering most RN apps, at their common versions, compiled per Hermes version on `deb` (pure compute), stored as a few-hundred-MB signature DB distributed separately from the repo (fetch-on-demand). Turns the common case into a local lookup; D17a's guess/confirm handles the tail. **Maintenance (Fred):** refreshed on a schedule (weekly cron on `deb`, later GitHub Actions) that fingerprints only new package versions and new Hermes versions; the DB is **append-only** — signatures are never removed, because apps in the wild ship package versions that are years old — and each refresh is published as a versioned, fetch-on-demand release with all prior releases kept as an archive. The repo carries only the index and the build scripts.

## D17b — Signature DB layering; the tool must work with no shared DB (2026-08-30)
Lookup order: **project-local** (`<out-dir>/.hbc2js/sigdb/`, or `--sigdb <dir>`; written by `hbc2js deps --confirm`, committed with a decompilation project so results are reproducible offline) → **user cache** (`~/.cache/hbc2js/sigdb/`) → **shared** (`tools/pkgsig/db/` in this repo; optional seed; `--no-shared-db` disables) → **guess-and-confirm via npm** (D17a; `--offline` disables). One file format across layers, so project DBs can be contributed upstream by copying. Seeding the shared DB uses the corpus apps as queries (npm packages only ever get fingerprinted; never app code).

## D19 — Output is a project tree, split per Metro module, with a screens index (2026-08-30)
Metro preserves one `__d(fn, id, deps)` entry per source file, so M6 emits one file per module with `require()` edges restored, under `<out-dir>/src/`. Module names come from evidence in priority order: leaked relative import paths in strings, component `displayName`, react-navigation route registrations, error/warning prefixes, `package.json`-style name/version strings; otherwise `module_<id>.js` with a comment listing what requires it. Recognised npm packages (D17) are removed from `src/` and listed in the emitted `package.json`. A `SCREENS.md` index maps navigator route names → screen module file → components rendered, giving a per-page view of the app. Entry module becomes `index.js`.

## D22 — The M4 runtime-helper set is "every VM primitive with no JS surface form", not literally four (2026-08-30)
Spec 05 §7.3 lists four sanctioned helpers and says a fifth needs a decision here.
Implementing the baseline showed the *criterion* in §7.1 is right and the *count*
was an underestimate: the construct corpus reaches VM primitives that have no
direct JS form beyond the generator protocol, `arguments` reification and
`CallBuiltin`. The emitted set, each emitted only when used (EM-03):

| Helper | VM primitive |
|---|---|
| `__hbc_makeGenerator` | v≤96 generator resume protocol (`SaveGenerator`/`ResumeGenerator`), driving the frame factory spec 05 §7.2.1's state contract requires |
| `__hbc_makeGeneratorLowered` | v≥97 `CreateGenerator` shim (D9) |
| `__hbc_arguments` | `ReifyArguments` — an **unmapped** object (D14/§8) |
| `__hbc_empty` | the "empty" sentinel `LoadConstEmpty` writes and `ThrowIfEmpty` tests; collapsing it to `undefined` would erase every TDZ check the bytecode *does* have |
| `__hbc_iterBegin` / `__hbc_iterNext` / `__hbc_iterClose` | `IteratorBegin`/`IteratorNext`/`IteratorClose`, each of which writes two registers |
| `__hbc_pnames` / `__hbc_nextPName` | `GetPNameList`/`GetNextPName` |
| `__hbc_HermesInternal` | the Hermes *host* object; `hermesc` lowers template literals to unconditional `HermesInternal.concat(...)` with no fallback, so output that reads it off `globalThis` runs nowhere but Hermes |
| `__hbc_b_*` (18) | the **internal** entries of the `CallBuiltin` table — `arraySpread`, `copyDataProperties`, `copyRestArgs`, `spawnAsync`, `getTemplateObject`, … — which are runtime intrinsics, not JS globals |

Builtins that *are* real globals (`Math.floor`, `JSON.stringify`, `Object.keys`,
`String.fromCharCode`, `globalThis.Symbol`, …) get no helper: `src/emit/builtins.ts`
emits the call directly. `exponentiationOperator` is inlined as `a ** b` for the same
reason — §7.1 forbids a helper for anything with a JS surface form. Every helper is
self-contained, emitted inline, and covered by a test; the only module state is
`__hbc_b_getTemplateObject`'s cache (tagged-template object *identity* is observable
and cannot be reproduced without one) and `__hbc_delegated` (`CallBuiltin
generatorSetDelegated` names no generator — it always means "the one currently
stepping").


## D16a — On-device round-trip tier (C6) (2026-08-30)
For apps whose source and build we control (RN template, react-navigation example), the ultimate test: decompile → recompile with `hermesc` → repackage the APK → install on an attached Android device via adb → launch → compare screenshots and logcat with the original build. Runs as a sweep-tier test when a device is present, INCONCLUSIVE otherwise. Never applied to proprietary APKs. **Tiering (2026-08-30, Fred):** too slow for the per-commit gate, but it is the control for the M5 ladder — it runs as part of every pass review (after each pass lands), because it exercises the real RN runtime loading real decompiled bundles, which the fixture harness cannot. Later: nightly on `deb` with a headless emulator.

## D19a — Multi-bundle apps are decompiled as one app (2026-08-30)
Real apps ship multiple Hermes bundles: Wix (30 micro-frontend bundles with one shared-dependencies bundle the others `require` into), Klarna (1,108 per-feature bundles, each paired with a plain-JS twin — OTA/code-push style), Teams (three feature bundles inside a native app). `hbc2js <app.apk>` therefore treats the APK as the unit: enumerate every bundle (`.hbc`, `.bundle`, plain JS), decompile each, resolve cross-bundle module references (a feature bundle's external requires bind to the shared bundle's exports), de-duplicate bytecode/JS twins by content, and emit one project tree with a subdirectory per bundle plus `BUNDLES.md` describing the graph. Dependency extraction (D17) runs once over the union so shared packages are reported once. Single-bundle apps are the degenerate case.

## D17d — Dependency extraction is scored against ground truth from our own builds (2026-08-30)
For every open-source app we bundle (C3), also emit Metro's source map (`--sourcemap-output`), which records the source file — hence the npm package and version from its `package.json` — of every module. That is the per-module ground truth. A `deps-truth` test runs `hbc2js deps` on the bundle and reports **precision** (packages reported that are truly present), **recall** (present packages found), and per-module attribution accuracy, with the false positives and misses listed by name. Thresholds gate CI: false positives at "confirmed" tier must be zero; guessed-tier precision is reported, not gated. Same for `.obf`/`-g` variants so fingerprinting must be robust to debug info and obfuscation.

## D20 — Output language is JavaScript; framework recovery is a pass layer (2026-08-30)
Hermes bundles are React Native, i.e. React compiled to JS — there is no Vue/Svelte in them. Output is always JavaScript. Framework-level readability comes from passes: **JSX recovery** (`React.createElement`/`jsx()` call trees → JSX; component `displayName`s → names) joins the M5 ladder as a high-value pass. For the plain-JS/Capacitor frontend (D18), Vue render functions → `.vue` SFC recovery is feasible and Svelte's imperative output is hard; both are D18 items, not Hermes work.

## D21 — Release benchmark page (planned) (2026-08-30)
At release, a script-generated comparison: the same bundles through hermes-dec, hermes-decomp, droidsaw-hermes and hbc2js, measured on runs/`node --check`, equivalence-gate result, structures recovered (loops/try/generators), % of modules stripped as recognised dependencies, time per MB. Claims in the README come only from that script's output.

## D12a — Passes are self-contained modules; implementers read one page + one spec (2026-08-30, amended 2026-08-30 by `docs/specs/passes/01-framework-fixes.md` F3 — the README wins on the point below)
Each pass is `src/passes/<name>/{index.ts,match.ts,rewrite.ts,check.ts}` plus `tests/gate/passes/<name>.test.ts` (corrected from an earlier, never-implemented `src/passes/<name>/<name>.test.ts` — `loop-cond.test.ts` already lives under `tests/gate/passes/`, and `tests/gate/passes/imports.test.ts` requires that file to exist per registered pass) and one catalogue row. Which spec: an idiom rung's (a numbered catalogue row) is `docs/lowering/<idiom>.md` §§1–7; a readability rung's (an `R`-numbered row — it recognises no Hermes idiom, so it has no `docs/lowering/*.md` evidence file) is `docs/specs/passes/NN-<rung>.md`, same seven sections. `docs/specs/passes/00-LADDER.md` is the ladder's architecture document, not a per-rung spec. The framework contract (tree-IR node types a pass may touch, the `Pass` interface, the registry, per-site abandonment, how to run one pass on one fixture) is a one-page `src/passes/README.md`. A pass may import only `src/passes/framework` (`tree.ts` for stage A, `ast.ts` for stage B) and `src/structure`'s public IR/verifier types — never `src/emit`, `src/cfg`, or another pass. Consequence: a pass can be implemented by a cheap model that has read exactly two documents, and reviewed in isolation. Enforced by an import-boundary test.

## D22a — Adversarial fixture tier: deliberately hard-to-decompile code (2026-08-31)
The 57 construct fixtures are "normal" code; reviews keep finding correctness holes (e.g. call-shape H1's getter double-eval) that the tame corpus never exercises. Add `tests/fixtures/adversarial/<NN-name>/` — programs written to *break* the decompiler: evaluation-order traps (side-effecting getters/Proxies as callee/receiver/arg, receiver double-eval, argument order), closures over loop vars, try/finally with control flow in the finally, generator/async edge cases (yield in finally, .return()/.throw(), delegation, microtask order), value oddities (BigInt, -0, NaN, Symbol keys), class private/static/accessors, side-effecting destructuring defaults, TDZ/hoisting. Each: deterministic, print()-only, one hard pattern, compiled all versions, `expected.txt` from Node. A fixture that makes `hbc2js` DIVERGE or ERROR is a **found bug**, not a gate failure: it goes to `docs/BUGS.md` + the **reported-but-non-gating** `adversarial` sweep tier until fixed, then graduates to the gate. Fixtures that pass join the gate. Goal: the oracle, not manual review, catches these.

## D17e — Dependency-recall benchmark on a purpose-built RN app (backlog) (2026-08-31)
The headline claim is "strip the ~85% library bloat." Add a standing test that MEASURES it on a **properly-built** RN app with a known dependency set, not toy fixtures. Build a fixture app (`tests/fixtures/bundles/deps-benchmark-app/`) whose `package.json` deliberately pulls in the common RN "bloat" set (react, react-native, @react-navigation/{native,stack,drawer,bottom-tabs}, redux+react-redux+@reduxjs/toolkit, lodash, axios, moment/dayjs, react-native-reanimated, react-native-gesture-handler, react-native-svg, react-native-safe-area-context, zod, formik, …), with a tiny amount of app code importing each. Bundle with `react-native bundle` + a Metro **source map** → per-module ground truth (which package each module belongs to, D17d). Then `hbc2js deps` and report **recall two ways: by module count AND by instruction weight** — "of the dependency code actually in the bundle, what fraction did we identify?" — plus false-positive rate. Wire as a sweep-tier benchmark (INCONCLUSIVE without the fixture/network), assert a **floor** so recall can't regress, and print the headline % (target: most of the bloat). Run at HBC 94 and 96/98 (build the app at a couple of RN versions) so version-skew is exercised. This is the number that answers "is the tool doing its job"; track it in STATUS as it improves with the bulk DB + version-tolerant matching (issue #14).

## D17f — Seed the signature DB from real open-source apps' EXACT dependency versions (2026-08-31, Fred)
Root cause of low real-app recall (Bloomberg 6.6% by weight): the DB lacks the exact package *versions* apps ship (we sampled ~few versions/package; a 0.72 signature can't match a 0.73 app). Fix by building the DB from reality: for each open-source RN app we can build ourselves (has package.json + lockfile → exact versions, and a Metro source map → per-module ground truth), compile it, fingerprint **every dependency at the exact version the app uses**, add to the DB, and **verify the tool recovers ~100% of that app's known deps** (this is the D17e/D17f benchmark). Repeat across many apps → real-world version coverage accumulates, each app less manual. Then a black-box app's deps are likely versions already fingerprinted from other apps → high recall. Complements on-demand `--confirm` (which fetches the exact version per-app when the DB misses). This is the primary path to the "strip ~85% bloat" goal.

## D17g — String-candidate detection + brute-force version confirmation (2026-08-31, Fred)
The "force" that removes the pre-seeded-version requirement. Two stages:
1. **Candidate by strings (version-independent):** a module's string constants (error messages, `node_modules/<pkg>/…` paths, distinctive identifiers, license banners) identify the LIKELY package even for a version we never compiled. High-recall candidate list; strings survive compilation and rarely change across versions.
2. **Confirm by trying versions (exact):** for each candidate, fetch its npm versions, compile at the app's detected HBC version, and match against the module's normalized bytecode. The version that matches confirms the package AND pins the exact version. Cache the winning signature (grows the DB, feeds D17f).
Efficiency (don't compile hundreds): narrow the version range first (string-leaked version, the app's RN release, publish-date window), then **binary-search by publish date** (bytecode drifts ~monotonically across releases), stop at first exact match — usually a handful of compiles per candidate. For the string-candidate step, REUSE existing web-JS library-detection signature sets rather than reinventing — Retire.js (has permissive signature data) and Wappalyzer-style name/path/error-string patterns already map distinctive strings → package; adapt them as the candidate seed (no such data exists for Hermes *bytecode*, which is why stages 2 compiles). This is the on-demand backbone: string-candidate → bounded brute-force confirm → cache. Combined with D17f (pre-seed from real apps) it targets the ~85%-bloat-stripping goal without needing every version pre-loaded. Extends D17a's `--confirm`.

## D17h — Anonymous library classification: mark a module "library, ignore it" WITHOUT naming it (2026-08-31, Fred)
Naming a dep (package@version) is the hard problem; CLASSIFYING a module as third-party-library-vs-app-code is easier and delivers the core goal (shrink the RE surface to the app's own code). Ship this as a first-class capability, separate from naming:
- **Primary signal — cross-app recurrence:** a module whose normalized content hash appears in N+ *unrelated* app bundles is shared library code by definition (an app's own logic never recurs across many apps). Build a "commonality index" from the corpus of real bundles (own + open-source; proprietary hashes only, per D16). Recurrence ≥ threshold → mark **library (anonymous)**.
- **Supporting signals:** `node_modules/<...>` paths / package names in the module's strings; structural shape (many tiny functions, no app-specific routes/strings/asset refs).
- **Output = two tiers:** (1) NAMED deps → package.json (D17f/D17g); (2) ANONYMOUS library — "third-party boilerplate, ignorable," no name. The HEADLINE metric becomes **% of bundle that is app-code vs library** (by instruction weight), which anonymous classification can push high even when naming recall is low. The analyst's real need — "show me only the app's code" — is met by tier 2 alone. This is arguably the FIRST recall win to ship.

## D17j — Custom-vs-library classification from the app's OWN vocabulary (corpus-independent) (formerly written D17h-b) (2026-08-31, Fred)
What matters most is 'is this the developer's custom code?' — answerable WITHOUT naming and WITHOUT a big cross-app corpus, using signals inside the single bundle:
- **App-vocabulary presence (primary):** learn the app's own vocabulary from the bundle itself — the most frequent app-specific string constants (route/screen names, the app's API hostnames, UI copy, the app's own scoped package name / bundle id, distinctive identifiers) and what the entry module transitively imports. A module that references the app's vocabulary → CUSTOM. A module with only generic strings → LIBRARY.
- **node_modules path evidence:** `node_modules/<pkg>/…` (and package-name) substrings in a module's strings → library (many bundles retain some; when a Metro source map is present it's definitive).
- **Structural shape:** many small pure utility functions, polyfill patterns, no app-domain strings → library; app-specific strings / JSX screen trees → custom.
These are the PRIMARY classify signals (work on a brand-new app out of the box); cross-app recurrence (D17h) is a bonus that improves with corpus size. Headline metric stays 'app-code vs library by instruction weight'. Getting custom-vs-not right is more valuable than naming the library.

## D17i — Dependency workflow is staged: isolate → classify → name (2026-08-31, Fred)
The canonical deps pipeline, in stages so each ships value independently and a failed later stage never blocks an earlier win:
1. **Isolate** — split every Metro module (`__d(fn,id,deps)`) into its own file with `require()` edges restored (= M6/D19 module splitting). Output: files, unnamed.
2. **Classify (library vs app code, WITHOUT naming)** — per file, decide third-party-library vs the app's own code via D17h (cross-app recurrence + `node_modules/…` strings + structural shape). Library files → a `vendor/`/`node_modules`-style area; app code → `src/`. **This stage alone delivers the headline goal** ("show me only the app's code"); it does not require naming or versioning.
3. **Name / find on npm** — only for the library files: exact-version DB match (D17f); for misses, string-candidate → brute-force version confirm (D17g). Hit → `node_modules/<pkg>@<ver>/` path + `package.json` entry. Miss → stays an anonymous vendored-library file (still ignorable).
Value ladder: isolate → files; classify → "app code vs boilerplate" (the real win); name → reconstructed package.json + node_modules. Because isolate+classify precede naming, the hard/uncertain naming step never blocks the useful output. Implement in this order.

## D23 — Stage invariant: structure-recovery before renaming; matchers migrate toward def-use, not register identity (2026-09-03, Fred + Claude Sonnet 5)
Fred (2026-09-03): "renaming should happen after all the structure things — keep it in computer language until you extract it down to natural language." Formalised in `src/passes/registry.ts`: every stage-B pass rung is either a **structure-recovery** rung (rewrites *shape* — `expr-rebuild` … `optional-chain`, `jsx-recover`) or a **pure-renaming** rung (`fn-naming`, `reg-split`, `var-naming` — each already documented "no statement moves, no expression changes shape"). All structure-recovery rungs are registered before all renaming rungs, using the registry's existing `after`/`before` mechanism (no new framework): a renaming rung may assume the tree's shape is final; a structure rung may assume every register still carries its original bytecode identity, because renaming has not run yet. This resolves `docs/BUGS.md`'s 2026-09-02 P-11b row: `jsx-recover` is a structure-recovery rung (it turns a call *shape* into a JSX node) that the old order ran *last overall* — after `reg-split` and `var-naming` — so `reg-split`'s per-store register renaming corrupted the def-use pattern `jsx-recover`'s matcher keyed off before `jsx-recover` ever saw the tree. Moving `jsx-recover` to the end of the structure-recovery block (still opt-in, still before the renaming block) fixes the interaction at its root; `reg-split` no longer runs before any structure rung, so `docs/PUSHBACK.md`'s P-11 default-on follow-up closes and `reg-split.optIn` flips to `false`.

**Forward rule (extends CONSOLIDATION §B's "no name-shape regex in tests" spirit from tests to matchers, QUEUE item 2b):** a pass's `match.ts` should key off def-use / value-flow shape (what a register is *defined from* and *used for*), not off a specific register name or numbering — a matcher keyed on identity is exactly what broke here, and the class of bug recurs for any future renaming rung placed ahead of a shape-matching one. Existing matchers migrate gradually rather than as one review-blocking rewrite; `jsx-recover`'s matcher is the first candidate (it is the one this decision's bug hit), reviewed as its own task, not a side effect of this one.

## D24 — The structurer's recursion budget is spent on nesting, and a host stack overflow is converted at exactly one place (2026-09-04, Claude Opus 5)
`ramsey` (`src/structure/structure.ts`) recursed once per *block*: a straight line of blocks with nothing nested inside it cost as much stack as a genuinely nested one, so `maxDepth` (default 1500, documented as a nesting guard) never got to fire on flat input — V8's real stack ran out first, with a raw `RangeError` (docs/BUGS.md 2026-08-30, T14). Two rules follow, and both are load-bearing:

1. **A `doTree` frame means nesting, never length.** A `jump`/`fallthrough` chain is walked iteratively in one frame: `doBranch` is split into `resolveBranch`, which returns either a finished `Stmt` (`break`/`continue`) or the *id* of the next subtree, and `doTree` loops on the id instead of recursing. Everything that is really nested — branch arms, switch arms, try bodies, merge kids, loop bodies — still recurses and is still what `maxDepth` counts. The output is unchanged by construction: `seq` flattens nested `seq` nodes, so accumulating a chain's leaves into one list yields exactly the tree the nested form built, and the leaf side effects (`emitted`, the expansion budget, `seenBlocks`) keep their order. This is the preferred fix because it makes the guard mean what it says rather than merely surviving its failure.

2. **One conversion site for host stack exhaustion, at `ramsey`'s entry.** How many native frames one nesting level costs is a property of the host (stack size, Node version, inlining), not of this code, so on a cramped or already-deep stack V8 can still run out before a *nesting* count of 1500 — measured: 3000 genuinely nested levels overflow on macOS/Node before the guard fires. `ramsey` therefore catches a `RangeError` whose message contains "Maximum call stack size exceeded" around its single top-level `doTree` call and rethrows it as `Hbc2jsError` `E_TOO_COMPLEX` (functionIndex + section). It is caught *there and nowhere else*: at the entry point the stack is fully unwound and nothing of the failed attempt survives, whereas an inner catch could swallow an overflow raised by unrelated code and continue with a half-built tree. It is deliberately not turned into `NeedDispatch` (which `auto` would answer by falling back to dispatch mode): a stack overflow says the host could not finish the analysis, not that the graph is irreducible, and silently downgrading to a dispatch-loop decompilation would hide that.

Consequence for tests: assertions about this behaviour must be stack-size independent — the flat cases because a chain now costs O(1) frames, the nested case because both guards produce the same `E_TOO_COMPLEX`. That is what makes `tests/gate/structure/recursion-guard.test.ts` portable where the two earlier attempts to pin the bug (which measured the host's usable stack) were not.

## D25 — Scoped single-function readable decompile: global analysis is paid once, per-function structure+emit is not (2026-09-04, Claude Opus 5)
`hbc2js decompile <bundle.hbc> --fn N` (and the library entry `decompileFunction(bytes, N, opts)`) render ONE function's readable JavaScript — with its nested closures placed inside it exactly as the whole-module render would place them — without structuring and emitting the other ~43k functions of a real bundle. Backlog item 3 (`docs/specs/hunt-tooling-backlog.md`); the mechanism is a new `EmitOptions.onlyFunction` on the same `emitModule` (no fork of the pipeline).

**Where the whole-bundle time actually goes (measured on the NSW bundle, 43,384 functions, numbers only).** For one function, `decompile()` splits into: parse 56 ms, module analysis (decode + classify every function) 886 ms, and `emitModule`, inside which the env graph builds on first access (~1.7 s) and the placement setup runs (~0.7 s). Of a 3.4 s scoped `decompileFunction` run, the target's OWN work — `structure()` + stage-A passes + stage-B AST passes over its closure subtree — was 25 ms (2.2 ms + 22.7 ms); everything else is the bundle-wide analysis below. The whole-module render additionally structures+emits all 43k functions, which dominates: it is the ~90 s (production build) that hits the CLI's timeouts, and under the identical node type-stripping loader used for the scoped measurement it had not finished after 20 min. So the scoped render is ~3.4 s vs the whole bundle's minutes — a >25× win — and its incremental cost per function is tens of ms.

**What is inherently global, and is therefore computed once regardless of scope.** Closure environment ownership spans functions, so the env graph (`src/cfg/env-graph.ts`) is a whole-module fixed point (it decodes every function and iterates creation sites to resolve which environment each closure captures and where each slot is declared). Placement (`parentOf`/`childrenOf`, the joined-rehost and orphan-hosting rules in `emitModule`, `src/emit/placement.ts`) and the copy/recursion-group/loop-local tables are functions of the *whole* env graph — an orphan's host is chosen from all functions, a joined closure's home is the lowest common ancestor of ALL its creation sites — so scoping them to N's subgraph could change a placement decision. We do not attempt it: the scoped path runs the full global analysis and setup (~3.35 s on NSW) and only skips the per-function structure+emit of everything outside N's subtree.

**The guarantee, and the truth rule.** Every function's PRIMARY (copy-0) emission in the whole render is reached through the `childrenOf` tree with a context of `{path:"", remap:undefined}` — the only thing that varies down that tree is the `hosted` set of extra-copy names an ancestor already emitted. The scoped path reconstructs that exact `hosted` set by walking N's ancestor chain and simulating the extra-copy accumulation (O(chain depth), emitting no sibling), and keeps the ancestors marked `active`, so `emitOne(N)` reproduces N's slice **byte-for-byte** — same children, same inline/hoist decisions, same names — modulo only the top-level indentation of a fragment vs a nested body. This is asserted programmatically in `tests/gate/emit/scoped-decompile.test.ts` (scoped node deep-equals the whole-render node for a sample of functions incl. nested closures + captured variables, across versions). Because the fragment does not emit N's parents, identifiers N captures from enclosing scopes (`_e<env>_<slot>`, outer `_fn<n>`) legitimately appear free; a header comment marks the output as a scoped render and states this, and the module scope-check (`collectUnbound`/`checkBindings`) is intentionally not run on the fragment. Nothing is printed differently from the full render without that header saying so.

## D26 — Points-to edges are a SEPARATE index, and environment identity comes from the env graph (2026-09-05, Claude Opus 5)
The `require(N)` dynamic-dispatch points-to pass (`src/artifact/points-to.ts`, spec 17 §14.4, spec 10 §2.2a) writes `index/calls-resolved.jsonl` instead of adding rows to `calls.jsonl`, and takes environment identity from the module's already-built `EnvGraph` instead of a decode-only `GetEnvironment`-level walk of its own.

**Separate index.** `calls.jsonl`'s primary key is `(caller, site-ordinal)`; a points-to row's site is a pc, not an ordinal, so folding the two would either invent an ordinal or overload `site` with two meanings. Keeping them apart also means every existing reader of the calls index (native index, secrets xref, `src/mcp/leads.ts`, every committed test) reads byte-identical content to what it read before, and an artifact written before the pass existed still loads (the file is optional on read). The merge happens at query time in `who-calls`/`calls-from`, where each recovered row carries `confidence: "points-to"` so it can never be mistaken for a direct edge.

**Env graph, not a private walk.** The brief for this pass asked for a decode-only scanner in the style of `object-tables.ts`/`template-injections.ts`. That idiom is right for the per-register lattice and is what the pass uses, but environment identity is a WHOLE-MODULE fixed point (`GetEnvironment` levels, `CreateEnvironment` parents, closure capture sites): `src/cfg/env-graph.ts` already computes it, it is already built for the artifact's own semantic walk (so it costs nothing here), and `EnvSlot.accesses` is the only place that knows every store to a slot bundle-wide — which is exactly the fact the soundness rule needs ("resolve a slot only when EVERY writer proved the same module"). A second, weaker implementation of the same analysis is precisely how a wrong edge gets emitted. The one thing the env graph does not give is stores whose environment it could not resolve (`EnvGraph.unresolved`); those are handled by refusing every slot INDEX such a store writes, module-wide.

## D27 — `object-literal`'s rung position, and which store opcodes are provably an own-property define (2026-09-04, Claude Opus 5)
The `object-literal` rung (`docs/specs/passes/20-object-literal.md`, catalogue row 28) registers **between `optional-chain` and `jsx-recover`** — last but one in D23's structure-recovery block — and folds **only** stores whose bytecode opcode is an own-property define.

**Position.** `after: ["expr-rebuild", "global-access", "call-shape"]`: a store's value is a bare register until `expr-rebuild` has inlined the expression that produced it, so running earlier would rebuild `{x: r3, y: r2}` — no worse than the baseline, but no better either. `before: ["jsx-recover", "var-naming"]`: `jsx-recover` keys on the props **object** of an element-creation call, and a props object built by `NewObject` + stores is not an `object` node until this rung has made one, so the reverse order would leave every such element unrecovered; and D23 requires a structure-recovery rung to run while every register still carries its original bytecode identity, which this rung depends on twice over (it reads registers *and* the bytecode origin of the statements it deletes).

**Per-opcode equivalence.** `src/emit/lower.ts` lowers `PutNewOwnById`, `DefineOwnById`, `PutOwnByIndex`, `PutOwnBySlotIdx` **and** `PutById` to the very same JS AST node, `assign(member(rN, key), value)`. They are not the same program. Per the MIT-licensed Hermes repo's `BytecodeList.def` (never hermes-dec), the `PutNewOwn…`/`DefineOwn…`/`PutOwnBySlotIdx` family performs an own-property *define* — enumerable, writable, configurable, no prototype walk — which is exactly what a literal's `key: value` does. `PutById`/`PutByIdLoose`/`PutByIdStrict`/`TryPutById`/`PutByVal…` perform a full `[[Set]]`, which walks the prototype chain: with an accessor or a non-writable `a` installed on `Object.prototype`, `o = {}; o.a = v` runs the setter (or throws, in strict mode) and defines nothing, where `o = {a: v}` always creates an own data property. So `o = {}; o.a = v` is **not** foldable and the rung refuses it, even though it is the shape a reader would most like folded.

Telling them apart means reading the emitter's per-statement bytecode `Origin` stamp and mapping it back to an opcode. D12a forbids a pass from importing `src/emit` or `src/cfg`, so that lookup is **framework**: `originOf`/`opcodeAt` in `src/passes/ast.ts` (memoised offset->opcode index per `FunctionCfg`). A statement with no origin — one an earlier rung synthesised — is refused rather than guessed at. This is the first rung to consult bytecode provenance from stage B; the alternative, folding on printed shape alone, would have been a silent semantic change in exactly the pathological case the project's soundness rule exists for.

## D28 — Graph view: React Flow + dagre, and scale is answered by the contract, not the renderer (2026-09-05, orchestrator, delegated by Fred)

Fred delegated the graph-library pick (QUEUE Needs-Fred item 5) on 2026-09-05.
The pick is **React Flow (`@xyflow/react`, MIT) + `@dagrejs/dagre` (MIT)**,
pinned exactly in `ui/package.json` — spec 20 §2.4's own recommendation.
**elkjs is rejected**: EPL-2.0 is a weak copyleft and the tree stays cleanly
MIT-compatible; nicer layered routing is not worth the licence class.

The load-bearing half of this decision is that **scale is handled by the
contract**: spec 19 §4 and spec 17 §14 serve neighbourhoods only (a function
and its direct callers/callees, a module and its direct edges) and cut
`module-graph` entirely, so the UI never draws the 4,510-module bundle at
once. That makes a mid-weight SVG/DOM renderer correct and WebGL (sigma.js)
unnecessary. If a low-hundreds-node neighbourhood ever stutters, the answer is
level-of-detail and node collapsing — both specified in spec 25 §5 — before
reaching for a different renderer. A whole-graph view would reopen this
decision, and would need its own spec first.


## D29 — The Stage-3 UI is built to specs 19–21, not to the MVP spec; their recommendations are ratified (2026-09-05, Fred)

Fred, 2026-09-05 07:20: *"Why are you using the MVP spec? I meant the final
one. The MVP was just because I didn't have lots of usage. Now I've got lots of
usage — use the real one from now on."*

That instruction ratifies the **recommendations** of the three investigations
that spec 22 had only defaulted past for the MVP:

- **spec 19 §3 Option A** — a local web app served by one Node process over a
  thin HTTP/JSON projection of `McpResources`/`McpTools`, with the six-layer
  test stack of §2. The wire is **HTTP/JSON**, not MCP (Option D); `ui/src/api.ts`
  is one table, so the MCP-as-wire option stays swappable. Co-hosting the MCP
  binding in the same process is deferred, not adopted.
- **spec 20 §3 stack** — React 19 + Vite, Radix, Tailwind-as-token-plumbing,
  CodeMirror 6, React Flow + dagre (D28), TanStack Table + Virtual,
  react-resizable-panels, Playwright. Two substitutions made during the MVP are
  ratified as built rather than reversed: **no shadcn/ui** (Radix primitives
  plus a hand-rolled `ui/src/components/primitives.tsx`, which already is
  "components as source you own"), and **no react-arborist** (TanStack Virtual
  plus own tree state, which spec 20 §2.5 itself allows). Token format is
  `ui/theme.json` → preset JSON → CSS vars → Tailwind `@theme inline` — a
  superset of spec 20 §4.4's "Tailwind config is the token layer", because it
  is runtime-switchable and gate-lintable. The token lint is a **hard** gate
  failure, as it already is.
- **spec 21 §3** — the append-only `log/` is the change feed and the in-process
  `wrote(seq, shardIds)` bus is a zero-latency doorbell over it (never a
  replacement); worktrees (or scratch copies) for `recompile_edit` sandboxes and
  version comparison only, never for annotations/findings, which spec 18 §7
  already made contention-free.

What this decision does **not** decide, because it needs Fred's own eye: the
art-direction seed and reference set (spec 20 §1.5/§1.4), visual-baseline
approval (the existing golden rule), whether `recompile_edit` may be driven from
the UI and with which sandbox (spec 17 §13 fenced it to the owner twice), and
the first-run information hierarchy (spec 20 §1.6). Those four, and only those
four, are `docs/specs/26-ui-full-ide.md` §4.

The build plan that executes this decision is **`docs/specs/26-ui-full-ide.md`**
(ten landings; contract-affecting first, then the token layer, then
user-visible value, then the missing test layers, then the heavy/risky, then
workspace polish). Spec 22's §1 table of MVP defaults is retired by it row by
row (spec 26 §1).

## D30 — The listing is a viewer: selection is a token, text entry only in a write dialog (2026-09-05, Claude Opus 5, from Fred's burs 2 and 7)

Fred: *"the `|` caret that you can edit text with is wrong unless you enter an
edit mode which would check for the same syntax; a selector based on words is
better"*, and *"double-clicking is good UI but it must not navigate on a token
that has no target"*.

Ratified for the whole UI, not just the centre pane:

1. **No caret anywhere a listing is shown.** Read-only is not enough — a
   painted caret is a promise the pane cannot keep. `drawSelection()` is not
   installed and `.cm-cursor` is hidden (`ui/src/listing/cm-theme.ts`).
   Browser text selection (drag, Cmd-A, copy) stays.
2. **The unit of selection is a token**, not a character offset: identifier,
   definition, property, keyword, string, number, comment, punctuation
   (`ui/src/listing/token.ts`, CodeMirror-free so the classification can be
   reasoned about and tested without an editor). One click = one
   `select()`.
3. **Navigation must resolve before it moves.** Double-click activates the
   token only when it is name-like *and* a symbol source resolves it (the
   file view's own function ranges, the emitter's `_fn<n>` convention, this
   module's names, then `GET /api/search/functions`). Anything else flashes
   "no target" and leaves the selection where it is. A pane may never
   navigate to a function id it has not resolved — that is what produced a
   blank listing.
4. **Text entry lives in a write dialog, never in the listing.** An edit
   mode exists only where a write tool exists (`annotate.rename`,
   `annotate.comment`); it validates before commit
   (`validateIdentifierName`: JS identifier syntax, not a reserved word,
   not `undefined`/`arguments`/`eval`) and shows the affected-reference
   count. hbc2js is not building a general text editor over decompiled
   output — the artifact is the source of truth and every change to it is a
   logged, hash-locked write.

## D31 — `recompile_edit`'s sandbox defaults to a temp copy, and the attended-only rule is enforced at the route (2026-09-05, Claude Opus 5)

Spec 26 L8 had to pick a sandbox kind and a place to enforce "attended only";
spec 26 §4.3 reserves the *final* word on both for Fred, so this decision is
what ships until he answers, chosen so that his answer is a one-word change.

1. **Default `kind: "copy"`** (a `mkdtemp` directory), not a git worktree.
   `recompile_edit` is a single-file patch — one function's source, one
   `hermesc` call — which is exactly the case spec 21 §2.4 says "a plain
   scratch directory may suffice" for. A worktree earns its keep when the
   experiment needs the whole tree and git's diff, which this one does not,
   and requiring one would break the common deployment where the `.hbcproj`
   sits next to an APK outside any git checkout. `kind: "worktree"` is
   implemented and tested alongside it, selectable per request, and it
   **errors rather than degrading to a copy** when there is no checkout: a
   caller who asked for git's diff must never be told it got one.
2. **The attended-only rule is a route-level refusal**, not a log audit.
   `POST /api/tools/recompile-edit` answers 403 for a worker provenance
   (`source: "llm"`, or `who` starting `worker:`) before a sandbox exists,
   because spec 23 §7's rule ("no worker may call it unattended") is about
   what may *run*, and a check that happens after the binary exists is not
   that rule. The UI's two-step confirm is the second, independent half.
3. **The recompiled artifact outlives the sandbox.** `outputPath` stays in
   `McpTools`' own scratch dir. The sandbox holds the speculative *source*
   (spec 21 §2.1's actual argument); tearing down the artifact the caller was
   just told to inspect would hand back a dead path.
