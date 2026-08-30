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

## D12a — Passes are self-contained modules; implementers read one page + one spec (2026-08-30)
Each pass is `src/passes/<name>/{index.ts,match.ts,rewrite.ts,check.ts,<name>.test.ts}` plus `docs/specs/passes/NN-<name>.md` and one catalogue row. The framework contract (tree-IR node types a pass may touch, the `Pass` interface, the registry, per-site abandonment, how to run one pass on one fixture) is a one-page `src/passes/README.md`. A pass may import only `src/passes/framework` and `src/structure`'s public IR/verifier types — never `src/emit`, `src/cfg`, or another pass. Consequence: a pass can be implemented by a cheap model that has read exactly two documents, and reviewed in isolation. Enforced by an import-boundary test.
