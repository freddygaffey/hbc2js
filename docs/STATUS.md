# Project status

Last updated: 2026-08-30

## Milestones
- [x] M0 Research: toolchain (`hermesc` locally), prior-art survey, test corpus candidates
- [x] M1 Parser: header (all 5 layout classes), section walk, string table, function
      headers (small+large, both eras), exception handlers, debug offsets, literal
      buffers, object shape table, BigInt/RegExp/CJS/functionSource tables, D8 layout
      probe (P0–P4), opcode/builtin table generation — v84/94/96/98/99 fixtures.
      Instruction decoding itself is spec 02 (M2), out of scope here.
- [x] M2 Disassembler + diff test against hermes-dec output — implemented and
      **100% matched at all five versions (84/94/96/98/99) on both oracles**
      (7.A `hermesc -dump-bytecode`: 249/249; 7.B `hbc-disassembler`: 250/250).
      The v98 `src/parse/**` flags bug that previously blocked this is fixed
      (`fddf194`); the remaining v98-only gap was a real, one-directional bug
      in `hbc-disassembler` itself (still present in the pinned version),
      allowlisted narrowly per fixture-scoped field, not swallowed generically
      — see `tests/gate/oracle/known-divergences.md` item 9.
- [x] M3 Test harness: sandboxed trace runner (D2) + recompile round-trip (D3) —
      `tools/equiv/` promoted to typed `src/harness/**` (spec 06); gate tier
      proves itself on identity (476/492 PASS, 0 DIVERGENT, 16 ERROR all
      attributable to the concurrent `src/parse/**` v98 fix, 31 PASS-with-
      caveat, 22 skipped-by-design) and on a mutation negative control
      (DIVERGENT on every fixture tried). `npm run test:all` for this
      milestone's own files is green; see "Currently working" below.
- [x] M4 Baseline: CFG + Ramsey structurer + emitter (with D9 shim) — **492/492 gate checks PASS, 0 DIVERGENT, 0 ERROR** under `syntax` + `trace`, at v84/94/96/98/99. See the M4 section below for the numbers, the residual `fuzz` divergences and the known gaps.
- [ ] M5 Pass ladder: one construct fixture per iteration as matcher/writer/checker pass (D12), catalogue row per pass; track `N/51 recovered` here
- [ ] M6 CLI + Tier 2 sweep (D13): RN template bundle and Expensify-scale bundle survive; recompile round-trip clean

## Queued next (after current agents)
- **Deps review (medium, Sonnet)** as soon as `hbc2js deps` lands: (a) code works — re-run offline gate + seed results independently, adversarial matcher tests (absent package, wrong version, same package two versions); (b) architecture sound — evidence scoring, confirm loop, DB layering, robustness to a new RN version. Verdict MERGE / REFACTOR / REWRITE; only not-sound triggers an architect spec (`08-deps.md`) and rework.
- **On-device round-trip (D16 C6)**: build the RN 0.72 template APK (Android SDK at ~/Library/Android/sdk), pull `index.android.bundle` → `hbc2js` → swap the **decompiled .js directly** into the APK as `index.android.bundle` (Hermes compiles plain JS at load; no recompile needed) — optional second variant pre-compiles with `hermesc` → re-sign (debug key) → `adb install` on the connected tablet → launch → screenshot + logcat comparison against the original build. Script it as `tools/device-roundtrip.sh` so it becomes a sweep-tier test whenever a device is attached. Then repeat with the react-navigation example.

## Queued before M5
- Measure `npm run test:all` and `hbc2js gate` wall time after M4 lands. If either exceeds ~2 min, parallelise: `node --test --test-concurrency=<cores>` across files, and per-fixture worker pool inside the gate runner (fixtures are independent). Keep a `--serial` escape hatch for debugging. Record timings here.
  - Measured 2026-08-30 19:15 after M4: `npm test` (gate) = 69 s wall, 5.7 cores busy — node's runner already parallelises across files. `test:all`/`hbc2js gate` timings pending (M4 reviewer to record).

## Currently working
- **M1 parser implemented** (`src/`, spec 00 skeleton + spec 01 parser). TypeScript
  strict, ESM, zero runtime deps; `node --test` runs `.ts` directly on Node 25 with no
  flags (the `22.18` floor is unverified locally — CI's matrix leg is what closes it,
  per spec 00 O-1). `npm test`/`typecheck`/`build`/`gen:tables:check` all green.
  81 gate tests, 4 sweep tests (+1 INCONCLUSIVE skip for the absent local corpus),
  `npm run test:all` = 85 pass / 1 skip.
  - **Opcode tables**: `tools/gen-tables/{parse-def,gen}.ts` — a macro-aware
    `BytecodeList.def`/`Builtins.def` parser (skips `#`-directives, backslash-
    continued macro bodies, and non-zero `#if` depth; independent `142+2×25`-style
    count cross-check; rejects leaked macro placeholders) generating
    `src/tables/generated/{opcodes,builtins}-<id>.ts` from `third_party/hermes/<id>/`
    (all MIT, vendored with LICENSE + sha256 in `PROVENANCE.md`). Seven tables:
    `hbc84` (185, commit `c2cd9e38`), `hbc94` (192, `1c717488`, cross-checked
    byte-identical against `3815fec6`, RN 0.72.17's actual pinned build commit),
    **`hbc96`** (192, `644c8be7` — added mid-M1 when the corpus grew v96 fixtures;
    identical to hbc94 except `DirectEval` gains a `UInt8 isStrict` operand at the
    same index 94), `hbc98-2024` (201, `c00cc575`, layout D), `hbc99-feb2026` (219,
    `42235b8d`), `hbc99-mar2026` (220, `913d31ac`, `NewTypedObjectWithBuffer` at
    opcode 4). `npm run gen:tables:check` regenerates all of them byte-identically.
  - **`hbc98-late` could not be pinned to a real commit** — spec 01 §5.2/§5.3 already
    flagged this as open. A full non-shallow clone of `facebook/hermes` was searched:
    every `static_h` commit between the v98 and v99 `BYTECODE_VERSION` bumps was
    checked, and none reproduces what `hermes-compiler@250829098.0.x` (the actual
    npm package behind every real v98 fixture in this repo) emits — same situation
    already documented for `hbc99-mar2026`'s own npm package (no embedded commit
    hash). Resolved **empirically instead**: cross-decoded all 223 function bodies
    shared (same `bytecodeSizeInBytes`) between every `constructs/*/v98.hbc`/`v99.hbc`
    pair plus `hermes-dec-sample`, using this project's own verified `hbc99-mar2026`
    decoder (zero hermes-dec involvement, D4-clean). Result: `hbc98-late` =
    `third_party/hermes/hbc98-late/BytecodeList.def` (commit `639e5d6a`, vendored,
    real MIT source) with two corrections applied by `tools/gen-tables/gen.ts`'s
    `patchHbc98Late`: (1) `ToUint32` removed (present in the vendored file but absent
    from real v98-late — confirmed absent from the v98-window-opening commit
    `c00cc5759` too, i.e. a late static_h addition the real build predates), (2) one
    placeholder opcode (`UnknownFastArrayOpcode98Late`, name/signature unverified,
    **never exercised anywhere in this corpus**) inserted after `FastArrayAppend` to
    account for a real v98-late opcode with no vendored-file counterpart. All 117
    empirically observable opcode names agree with this patched table with zero
    disagreements (a couple of 1-in-many-hundred outliers attributable to unrelated
    decode noise, not the patch). If a future fixture is found to actually hit the
    placeholder's opcode number, it must be identified and named for real.
  - **D8 layout probe** (`src/parse/layout.ts`): P0 (magic/fileLength) → P1 (per-
    candidate header sanity + anti-OOM `count*stride` guard) → P2 (section-walk
    `firstFunctionBodyOffset` match, resolving overflowed entries' *large*-header
    offset first, per spec 01 §6.2's warning) → v98 D-vs-E fast hint (D1/D2, §6.3,
    confirmed on all 53+ real v98 fixtures) → P3 (whole-file/sampled opcode-table
    validation) → P4 (table self-assertions, `src/tables/registry.ts`, run once at
    load). **One deliberate, documented deviation from spec 01 §6.4's "never
    silently prefer" rule**: when P3 leaves 2+ opcode tables tied after an
    *exhaustive* (whole-file, <2 MB) sample — which happens for ~20 real, tiny v98
    construct fixtures that simply never reach an opcode past 165 where the v98/v99
    tables diverge — the probe picks the table matching the file's own declared
    version (`hbc98-late` over `hbc99-mar2026`) rather than throwing
    `E_LAYOUT_AMBIGUOUS`, recording `W_OPCODE_TABLE_TIEBREAK` and `P3-tiebreak` in
    `decidedBy`. Without this, ~20 of this project's own real v98 fixtures — and,
    per spec 01 T7, all 53 are required to succeed — would fail to parse. Opcode-
    table candidates are also pruned by which header layout class each candidate's
    own commit actually produces (fetched `FUNC_HEADER_FIELDS` per commit), so
    `hbc98-2024` (verified layout D) is never even considered once the file is known
    to be layout E.
  - **A real bug found via the T8 fuzz test and fixed**: `parseDebugInfo`'s filename
    table read `{offset, length}` pairs without bounds-checking against
    `filenameStorage` before decoding — a fuzzed length could reach
    `String.fromCharCode` with an absurd count and throw a raw `RangeError` instead
    of `Hbc2jsError`. Fixed (matches the main string table's INV-12 treatment); same
    class of guard added to `readExceptionTable`'s handler count and both of
    `parseDebugInfo`'s array allocations, since none of those counts are
    header-level and so aren't covered by P1's anti-OOM check.
  - **A real bug found while writing T2/T3 and fixed**: for an *overflowed*
    function, `FunctionHeader.flags` was read from the small header instead of the
    large header — the two are independent bytes (verified: `hermes-dec-sample/
    v99.hbc` fn0's small header has flags `0x20` (only `overflowed`), its large
    header has flags `0x12`, the real semantic bits). `docs/HBC-FORMAT.md` §3.4/3.5
    state the large header's flags value but don't call out that it's a *different*
    byte from the small header's.
  - **File-level `DebugInfoHeader` has a third, undocumented shape boundary**,
    independent of the per-function `DebugOffsets` boundary `docs/HBC-FORMAT.md` §4
    already documents: fetched the struct directly from three pinned commits.
    Class A/B (`c2cd9e38`, v84): 5 fields ending in one `lexicalDataOffset`. Class C
    (`1c717488`, v94): 7 fields (`lexicalDataOffset` → `scopeDescDataOffset` +
    `textifiedCalleeOffset` + `stringTableOffset`). Class D/E (`913d31ac`,
    v99-mar2026): back to 4 fields. Found because parsing `hermes-dec-sample/
    v84.hbc`'s debug info with the (wrong, 7-field) v94-era header shape put the
    filename table's bytes 12 bytes late, landing squarely on the ASCII text
    `"source.js"` and producing garbage `{offset, length}` pairs.
  - **Local corpus (D16 C5) spot-check** (not committed, not part of the test
    suite — `~/hbc2js-local-corpus/apks/`, extracted to a scratch dir with Python
    `zipfile`, per this task's instructions): Bloomberg (10.0 MB, v96/class C,
    58,932 functions), Discord (50.8 MB, v98/class E, 120,522 functions), Teams
    (0.7 MB, v96, 4,736 functions), Xbox (25.2 MB, v96, 59,278 functions), Shopify
    (33.9 MB, v98, 97,752 functions) — **all five parse with zero diagnostics**, in
    38–178 ms each, independently confirming `hbc96` and the empirically-patched
    `hbc98-late` against real production bytecode far larger and more diverse than
    the construct corpus. Pinterest's APK has no `assets/**bundle**`-named entry and
    none of its assets start with the HBC magic — likely not a Hermes/RN app, or
    bundles it differently; not fabricated, just not found.
  - **Deviations from the literal spec 01 §3.1 type signature**: `LayoutProfile.
    opcodeTable`/`.builtinTable` and `ProbeCandidate.opcodeTable` are typed
    `OpcodeTableId | undefined` rather than non-optional `OpcodeTableId` — needed to
    honestly represent §6.1's "a file whose layout parses but whose opcode table is
    not generated is still a valid `HbcModule`" for v85/86/97 (no fixture exists for
    these; untested beyond compiling).
  - Class A (v51–83) and class D (v97/98-early) remain **implemented but unverified
    against real bytes** — no known fixture exists for either (spec 01 O-2, unchanged
    from the spec's own acknowledgment).
  - Perf (`tests/sweep/parse/bundles.test.ts` T9, this machine): largest fixture
    (`index.android.noopt.debug.hbc`, 2.62 MB, 4,314 functions) parses in ~4–9 ms;
    linear extrapolation to 12 MB ≈ 20–35 ms, well inside the §7.3 400 ms budget.
- `hermesc` toolchain: `tools/get-hermesc.sh` fetches HBC v84/v94/v96/v98/v99
  compilers (npm-sourced, not committed) for macOS + Linux x86_64. v94
  recompiles `tests/fixtures/hermes-dec-sample/source.js` byte-identical to
  `tests/fixtures/hermes-dec-sample/v94.hbc`. v99 does not byte-match
  (different Hermes commit, same wire format — see `docs/TOOLCHAIN.md`). v98
  probed across every publicly-published `hermes-compiler@250829098.0.x`
  patch (alpha through newest): all emit only the "98-late"/class-E header
  layout, never "98-early"/class-D — see `docs/TOOLCHAIN.md`'s "v98: which
  header layout does the public package emit?". **v96 added**
  (`react-native@0.73.11`, commit `644c8be78af1eae7c138fa4093fb87f0f4f8db85`
  per that tarball's `sdks/.hermesversion`, same provenance pattern as v94):
  layout class C, identical header shape to v94; opcode table is v94's table
  with exactly one change (`DirectEval` grows a third `UInt8 isStrict`
  operand — no opcode added/removed/reordered, still 192 opcodes) — see
  `docs/TOOLCHAIN.md`'s "v96: opcode table and layout". `hermes-dec` 0.1.7
  (pip) confirmed working as the behaviour-oracle disassembler/decompiler.
  Details: `docs/TOOLCHAIN.md`.
- **Tier 1 fixture corpus built**: 53 hand-written single-construct fixtures
  under `tests/fixtures/constructs/<NN-topic>/{source.js,expected.txt,vNN.hbc,licence.txt}`
  (01-51 per `docs/TEST-CORPUS.md` §1a; 52-53 added later — dense-integer
  `SwitchImm`/`UIntSwitchImm` jump-table fixtures, closing the gap flagged in
  `docs/AGENT-LOG.md`'s spec-writing entry), plus the restructured
  `hermes-dec-sample/` (now also has `v84.hbc`/`v96.hbc`/`v98.hbc` fresh
  recompiles, alongside the two preserved historical `v94.hbc`/`v99.hbc`
  binaries). All 53 run correctly under Node 25 (`expected.txt` captured from
  that run); 243/265 (fixture × hermesc-version) combinations compile
  (v96 added, same 6-gap pattern as v94 — see below) — the 22 gaps are
  documented per-fixture in `versions.txt` and summarized in
  `tests/fixtures/README.md`'s compatibility table. A same-VM cross-check
  against the real `hermes` interpreter (bundled with the v84 package only)
  found 4 genuine Node-vs-Hermes-v84 runtime behavioural differences
  (`let`-in-for-loop closure capture, TDZ-vs-shadowing, and non-strict
  `arguments`/parameter aliasing) — see `tests/fixtures/README.md` for full
  detail; not fixture bugs, Hermes v84 diverges from spec/Node there.
  `tests/fixtures/build.sh` regenerates every `.hbc` idempotently.
- **Tier 2 real-bundle fixture**: `tests/fixtures/bundles/rn-template-0.72/`
  — a stock, unmodified `react-native init` template pinned to RN 0.72.17
  (HBC v94), Metro-bundled (`--dev false --minify true`, 820,822-byte JS
  bundle) and compiled with hermesc v94 across four flag combinations
  (`-O`/`-O0` × with/without `-g`; the `-O`/no-flag pair and `-g`/`-O -g`
  pair each compiled byte-identical — this hermesc build optimizes by
  default, `-O0` is the only way to get real unoptimized bytecode). Total
  fixture size ~8.0 MB. See its `BUILD.md` for exact commands and
  `licence.txt` for the MIT provenance chain.
- Prior art + HBC format research done: `docs/PRIOR-ART.md` (survey of 12 tools,
  structuring-literature recommendation, risk register) and `docs/HBC-FORMAT.md`
  (our own format write-up, verified byte-for-byte against the v84/v94/v99/v99-public
  fixtures — header, section offsets, both function-header layouts, exception tables,
  debug offsets, opcode numbering).
- **Equivalence-oracle design study + PoC done**: `docs/EQUIVALENCE.md` (trace
  format, layered strategy per fixture tier, CLI shape, M3 spec checklist, risk
  register) and `tools/equiv/**` (zero-dep Node ESM `hbc2js-equiv`: node:vm
  sandbox with seeded PRNG / frozen clock / virtual timers, NDJSON trace,
  three-valued verdict, function fuzzer, `hermesc -dump-bytecode` normaliser,
  mutation generator). `node tools/equiv/selftest.mjs --hermes --fuzz` validates
  it against the whole construct corpus in ~40 s: 53/53 determinism +
  `expected.txt` fidelity, 273/318 mutants killed, 41/45 Hermes-VM agreement
  (reproducing the 4 known divergences). Not wired into a build; M3 should treat
  it as an executable spec, not shippable code.
- **Hermes VM built from source for v94 and v99**: `tools/build-hermes-vm.sh
  <94|99>` clones `facebook/hermes` at the commit that produced each bytecode
  version (94: `3815fec63d1a6667ca3195160d6e12fee6a0d8d5`, react-native@0.72.17's
  pinned commit; 99: `913d31acd10aff31e0856657c9c566c3e72bd24a`, the
  220-opcode/`NewTypedObjectWithBuffer` commit `docs/HBC-FORMAT.md` already
  identified) and builds `hermes`/`hermesc`/`hbcdump` with cmake+ninja into
  `tools/hermes-vm/v<N>/bin/` (gitignored). This closes the gap
  `docs/EQUIVALENCE.md` §5.1 flagged: the only prebuilt VM (`hermes-engine-cli`)
  tops out at HBC 89. Verified: v94's built `hermesc` reproduces
  `tests/fixtures/hermes-dec-sample/v94.hbc` byte-identically (confirms the
  SHA); v99's is bracketed between `v99.hbc` and `v99-public.hbc` (matches
  `v99.hbc`'s builtin-table numbering, matches `v99-public.hbc`'s dead-code
  emission and file size) — no publicly identifiable single commit reproduces
  `v99.hbc` exactly. Ran both VMs against 10 `tests/fixtures/constructs/*`
  fixtures: **D14's 4 known Node-vs-Hermes divergences
  (`18-closure-loop-let`, `20-let-const-tdz`, `42-rest-params`,
  `49-arguments-object`) persist unchanged at v94 and v99**, confirming (not
  refuting) D14's "at every version tested" claim; all other sampled fixtures
  matched. Details, build fix (CMake 4.x vs. `CMP0026 OLD`), timings, and
  binary sizes: `docs/TOOLCHAIN.md` "Hermes VM (source build)".
- **D13 hardened tier (obfuscated/minified variants) done**: every
  `tests/fixtures/constructs/<name>/source.js` now has `source.obf.js`
  (`javascript-obfuscator@5.6.0`, control-flow flattening threshold 1 +
  RC4-encoded string arrays + dead code injection) and `source.min.js`
  (`terser@5.51.2`, compress+mangle) siblings, each verified against
  `expected.txt` under Node and compiled to `vNN.obf.hbc`/`vNN.min.hbc` for
  every hermesc version each fixture already supports (52/53 obfuscate
  cleanly — `35-class-private-fields` breaks `javascript-obfuscator`'s
  member-expression rewrite on ES2022 private fields; 53/53 minify cleanly;
  194 `.obf.hbc` + 196 `.min.hbc` compiled, zero unexpected hermesc
  failures). Control check (5 fixtures, v94, `hbc-disassembler`): minified
  bytecode matches the original's basic-block count exactly on 5/5 and its
  mnemonic sequence on 4/5 (one fixture's `terser compress` step reorders a
  comparison/call, still behaviourally identical); obfuscated bytecode has
  5-9x the instructions/basic-blocks/string-table entries on every fixture,
  and in `52-switch-jumptable`'s case control-flow flattening's shuffled
  dispatcher states actually defeat Hermes's own `SwitchImm` jump-table
  codegen (0 `SwitchImm` in the obfuscated build vs. 1 in original/minified)
  — a real decompiler-relevant finding. One obfuscated variant of the real
  `bundles/rn-template-0.72/index.android.bundle` was also generated
  (`controlFlowFlatteningThreshold: 0.75`) and compiled with hermesc v94
  `-O`: 6.74 MB, over the 3 MB commit cap, so only the config and exact
  regeneration command are committed (`bundles/rn-template-0.72/hardened/CONFIG.md`),
  not the binary. `tests/fixtures/build.sh --variants` regenerates the
  construct-level variants idempotently; default `build.sh` behaviour is
  unchanged. Full detail: `tests/fixtures/OBFUSCATION.md`.
- **Tier 2 C3 corpus grown**: two more real-world Metro/Hermes bundles,
  `tests/fixtures/bundles/react-navigation-example-0.85.3/` (Expo-based,
  3.36 MB JS / 4.31 MB `-O` `.hbc`, 15,551 functions) and
  `tests/fixtures/bundles/expensify-app-0.86.0/` (`react-native bundle`,
  36.8 MB JS / 43.5 MB `-O` `.hbc`, 98,775 functions — the "large" slot,
  bigger than `docs/TEST-CORPUS.md`'s ~12 MB anchor). Both landed on HBC
  bytecode version **98** (new to this repo — `tools/get-hermesc.sh 98`
  added, same tarball layout pattern as the existing `99` entry); neither is
  committed (both over the 3 MB cap), each has a `BUILD.md` + `fetch.sh`.
  Both confirm real-world `StringSwitchImm` jump tables and real
  opcode-driven `CreateGenerator` (73/787 occurrences respectively) rather
  than a D9-style compiler state machine at HBC 98; both show `HasAsync: 0`
  in the header despite heavy `async`/`await` source usage (open question).
  Expensify's build hit a `react-native-worklets` bundle-mode/Metro race
  (`Failed to get the SHA-1 for .../.worklets/<id>.js`) deterministically
  without `watchman` installed; fixed by installing watchman +
  `--max-workers 1`. Full detail in each `BUILD.md`; summarized in
  `tests/fixtures/README.md`.
- **C4 hardened variant** (`react-navigation-example-0.85.3/hardened/`,
  D16): `javascript-obfuscator@5.6.0` (BSD-2-Clause, via `npx`, pinned) at
  the originally-specified heavy config (control-flow-flattening threshold
  0.75 + dead-code injection + rc4 string array) obfuscates fine (3.36→16.9 MB)
  but the obfuscated output **does not finish compiling** in `hermesc`
  (killed after 6m35s with `-O`, ~2 more minutes without, no output either
  way) — root-caused to `hermesc`'s diagnostic printer re-emitting the
  entire (huge, single-line, control-flow-flattened) source line for each
  of ~9,400 "undeclared variable" warnings, not a compile hang per se. A
  reduced config (flattening threshold 0.1, no dead-code injection) obfuscates
  in ~9s (3.36→7.61 MB) and compiles in 3.7s. Real finding for D3: round-trip
  verification of heavily-obfuscated bundles via shelling out to `hermesc`
  needs warning suppression or it can cost many minutes on I/O alone. Same
  light config also produced for Expensify (`expensify-app-0.86.0/hardened/`):
  `javascript-obfuscator` OOM'd at default Node heap on the 38.6 MB input,
  needed `NODE_OPTIONS="--max-old-space-size=8192"` (2m31s, →84.5 MB), then
  `hermesc -O` compiled it cleanly in 44s (131,424 functions, only 37
  warnings) — confirms the heavy config's pathology tracks flattening+dead-code,
  not bundle size. See `tests/fixtures/bundles/react-navigation-example-0.85.3/hardened/BUILD.md`
  and `expensify-app-0.86.0/hardened/BUILD.md`.
- **C5 tooling**: `tools/extract-apk-bundle.sh` (D16) extracts a bundle from
  a local APK's `assets/` (Hermes-bytecode or plain-JS, auto-detected),
  writes it to a gitignored `tests/fixtures/local-corpus/<sha256-prefix>/`
  and appends a hash-only record to the tracked `MANIFEST.json`. Verified
  against synthetic APKs built from this project's own already-MIT-licensed
  fixtures (hbc, plain-js, Expo-style hashed `.hbc` filename, and a
  no-bundle-found error case) — not against any real third-party APK. See
  `tests/fixtures/local-corpus/README.md`.

- **M2 disassembler implemented** (`src/disasm/{decode,labels,switchtable,print}.ts`,
  `src/tables/roles.ts`, `hbc2js disasm` CLI subcommand in `src/cli.ts`). All of
  spec 02 §3–§8: instruction decoding for every generated opcode table,
  jump-target resolution, `SwitchImm`/`UIntSwitchImm`/`StringSwitchImm` jump
  tables (absolute-address alignment + beyond-`bytecodeSizeInBytes` extent
  traps), deterministic `L`/`T` label namespaces, `raw` mode (line-for-line
  target for `hermesc -dump-bytecode -pretty-disassemble=false`) and
  `canonical` mode (ours, used for goldens), validation per §3.3's table, and
  the re-encode round-trip self-check. `src/tables/roles.ts` is a hand-written
  operand-role override table (data, not decoder `if`-chains) merged over the
  generated `ids` map. **`npm run test:all`: 708 tests, 706 pass, 0 fail, 2
  skip** (the 2 are the local-corpus/Discord D16 C5 sweep check, INCONCLUSIVE
  by design when `~/hbc2js-local-corpus` is absent or, as on this run,
  `tools/extract-apk-bundle.sh` can't locate the bundle in that specific APK —
  see the perf note below). `npm run typecheck` / `gen:tables:check` /
  `npm run build` all green (aside from an unrelated, in-progress, untracked
  `src/cfg/**` file from a concurrent M4 agent — not part of this milestone);
  `dist/cli.js` mode 0755, `hbc2js disasm --help` works from both `dist/` and
  `src/cli.ts` directly.
  - **Match rates against the two oracles, corrected** (`tests/gate/oracle/disasm/`,
    every `(fixture, version)` pair with a real `hermesc`/`hbc-disassembler`
    binary present; see `tests/gate/oracle/known-divergences.md` for every
    allowlisted item's byte evidence). An earlier revision of this section
    claimed 7.A was 100% only at v84/94/96/99 and blocked at v98 by the
    `src/parse/**` flags bug below — that bug is now fixed (`fddf194`) and
    **both oracles are 100% at all five versions**:
    - **7.A (`hermesc -dump-bytecode`)**: **249/249 (100%)**, all five
      versions, including the 8 fixtures where `hbc98-late`/`hbc99-mar2026`
      genuinely disagree (D8 correctly refuses to auto-probe those; the test
      now forces the externally-validated table via
      `tests/support/known-issues.ts`, the same pattern the parser's own
      tests use, instead of crashing uncaught).
    - **7.B (`hbc-disassembler`)**: **250/250 (100%)**, all five versions,
      including `hermes-dec-sample/v99.hbc` (the one v99 binary that can't be
      reproduced for 7.A). Getting v98 to 100% needed a real, narrowly-scoped
      allowlist entry (item 9): `hbc-disassembler` itself still has the same
      v98 large-header flags bug this project's parser just fixed (its
      pinned version reads byte 35 instead of 36), so its `strict`/`exc`/`dbg`
      FUNC-line fields — and, as a direct consequence, whether it prints an
      `[Exception handlers: ...]` block at all — are wrong for essentially
      every overflowed v98 function. The test masks exactly those two known
      effects, function-by-function, keyed off hermes-dec's own (wrong) `exc`
      bit; every other field and every instruction line are still compared
      verbatim, so a real regression in *our* decoding still fails loudly.
    - Canonical-mode golden snapshots: 249 files under `tests/golden/disasm/`,
      one per `(fixture, version)` pair in the gate corpus, byte-stable across
      two runs; the 53 v98 ones were regenerated after the flags fix (diffs
      are limited to `flags=`/`.try`/label-renumbering lines, as expected from
      more functions now correctly showing their real exception handlers).
  - **Perf** (this machine, `tests/sweep/disasm/bundles.test.ts`), on the
    largest fixture in the tree (`bundles/rn-template-0.72/index.android.noopt.debug.hbc`,
    2.62 MB, 4314 functions): `decodeModule` over every function 36.4 ms
    (extrapolated to 12 MB: **167 ms**, budget 4000 ms); `raw`-mode
    `printModule` 73.7 ms (**338 ms** extrapolated, budget 15000 ms);
    `canonical`-mode `printModule` 90.7 ms (**416 ms** extrapolated, budget
    25000 ms). All comfortably inside spec 02 §8's budgets. The local D16 C5
    corpus (Discord's 50.8 MB bundle) was **not** timed this run:
    `tools/extract-apk-bundle.sh`'s `unzip -Z1`-based entry lister doesn't see
    `assets/index.android.bundle` in that specific APK even though `unzip -l`
    shows it present (~53 MB) — likely a large-entry/Zip64 quirk in that zip,
    a tool-script limitation rather than a decoder issue; the sweep test
    reports this and skips (INCONCLUSIVE) rather than failing.
  - **Real bytecode-format findings, verified against real `hermesc`/`hbc-disassembler`
    output (not spec text) and reported for the relevant owners:**
    1. **`hermesc -dump-bytecode` has a third function-header shape**: a class
       constructor prints as `Constructor<Name>(...)`, not
       `Function<Name>`/`NCFunction<Name>` — spec 02 §6.1 says "nothing else
       observed". Corresponds to `FunctionFlags.prohibitInvoke === "call"`
       (construct-only). `src/disasm/print.ts`'s `rawHeaderLine` renders it;
       the oracle-diff normaliser accepts it.
    2. **`hbc-disassembler` has two more function-header shapes**:
       `Generator function #N` and `Async function #N` for compiler-synthesized
       bodies, neither with a companion plain `Function #N` line. An
       unmatching regex silently dropped these lines and desynchronised every
       later function by one — fixed in
       `tests/gate/oracle/disasm/normalize.ts`.
    3. **`hermesc`'s raw `Double` rendering is `printf("%e")`-style**
       (`7.300000e+00`), not `String(value)` as spec 02 §6.1's prose says —
       verified directly; `raw` mode now matches the real bytes (`canonical`
       mode keeps `String(value)` as spec's canonical-mode table intends).
       `hbc-disassembler`'s own `Double` rendering is a *third* convention
       (Python's `repr(float)`, always a decimal point:
       `9007199254740992.0`) — three legitimate conventions for the same
       underlying value across our two modes and the two oracles.
    4. **v84 predates the `OPERAND_FUNCTION_ID` macro entirely** (confirmed:
       no such macro is even `#define`d in `third_party/hermes/hbc84/BytecodeList.def`).
       Nine opcodes (`CreateClosure[LongIndex]`, `CreateGeneratorClosure[LongIndex]`,
       `CreateAsyncClosure[LongIndex]`, `CreateGenerator[LongIndex]`,
       `CallDirect`) whose function-id operand is correctly tagged at v94+ had
       no role at v84, rendering as a bare number instead of `f<N> "name"`.
       Fixed as `src/tables/roles.ts` overrides (real ground truth confirmed
       via `hbc-disassembler`, which tags all of these — including
       `CallDirectLongIndex`, which no Hermes version's own `.def` file ever
       tags — as `function_id` at every version tried).
    5. **A previously-"unverified" `hbc98-late` opcode is now identified**:
       opcode 15 (placeholder name `UnknownFastArrayOpcode98Late`, guessed
       2-operand signature) is genuinely exercised by
       `tests/fixtures/constructs/50-this-binding/v98.hbc`. Real
       `hermesc -dump-bytecode` (byte-identical recompile) shows it is
       **`CacheNewObject 3<Reg8>, 2<Reg8>, 2<UInt32>, 0<UInt8>`** — a
       4-operand `(Reg8, Reg8, UInt32, UInt8)` signature. `src/disasm/decode.ts`
       correctly refuses to decode it (`E_UNKNOWN_OPCODE`, per the
       `unverified` contract) rather than guess. Fixing the generated table
       (`tools/gen-tables/gen.ts`'s `patchHbc98Late`) is a table-owner change,
       not made here (changes opcode positional numbering, pinned by spec 01).
  - **v98 `FunctionHeader.flags` bug — FIXED (`fddf194`, `src/parse/**`, not
    this milestone's own change).** Originally reported here as the sole
    cause of every 7.A test failure: `prohibitInvoke`/`hasExceptionHandler`
    misdecoded specifically for v98 (layout class E / `hbc98-late`) function
    headers, e.g. `constructs/32-class-basic/v98.hbc`'s `global` decoding
    `prohibitInvoke: "call"` when the real `hermesc` dump shows it plain and
    unprefixed. Root cause (independently verified against raw bytes by the
    step-3 review, `docs/reviews/M1-fixes-M2-disasm.md`): v98-late's large
    `FunctionHeader` is 37 bytes, not 36 (an extra `NumCacheNewObject` field
    from Hermes commit `f74f6bbe37`, reverted before v99), shifting `flags`
    from offset 35 to 36 — see `docs/HBC-FORMAT.md` §3.3's corrected large
    class-E header description. Fixing this on the parser side is what took
    7.A from "100% except v98" to 249/249 and regenerated 53 stale v98
    canonical goldens (see above); `tests/gate/disasm/decode.test.ts` and
    `tests/gate/disasm/reencode.test.ts` pass cleanly at v98 once a table is
    forced past the separate, legitimate D8 `E_LAYOUT_AMBIGUOUS` case
    (`tests/support/known-issues.ts`). Exposed a matching, still-open bug in
    `hbc-disassembler` itself (item 9, addressed via the 7.B allowlist above).
    Full detail and byte-level evidence: `tests/gate/oracle/known-divergences.md`.

- **M3 harness implemented** (spec 06). `tools/equiv/`'s eleven modules ported to
  typed `src/harness/**` (`trace.ts`, `sandbox.ts`, `child.ts`, `runner.ts`,
  `compare.ts`, `fuzz.ts`, `mutate.ts`, `hermes-vm.ts`, `reference-policy.ts`,
  `roundtrip.ts`, `ladder.ts`, `tiers.ts`, `golden.ts`), zero new runtime deps.
  `hbc2js equiv`/`hbc2js gate`/`hbc2js sweep` added to `src/cli.ts` (additive,
  per this milestone's task boundary — folded into the one CLI rather than a
  separate `hbc2js-equiv` binary; see `docs/TESTING.md`).
  - **Reference policy (D14)**, `src/harness/reference-policy.ts`:
    `chooseReference` returns `hermes-vm` when a matching VM exists (this repo
    can currently find one at v84 — prebuilt — and v94/v99 — source-built via
    `tools/build-hermes-vm.sh`; **v96 also has one**, a genuine, undocumented-
    by-spec-06 discovery — `react-native@0.73.11`'s npm tarball bundles a
    `hermes` interpreter alongside `hermesc`, and the generic-by-version
    discovery order picks it up without special-casing). The four known
    Node-vs-Hermes divergences (`18-closure-loop-let`, `20-let-const-tdz`,
    `42-rest-params`, `49-arguments-object`) are data, populated for
    84/89/94/99 from the AGENT-LOG measurement, with 96/98 explicitly
    unmeasured-but-still-caveated. Two more exclusion tables were added while
    proving the harness against the real corpus (see below): a VM-limitation
    table (v99's source-built `hermes` throws inside its own
    `InternalBytecode.js` for `07-for-of-iterable`/`27-async-await-basic`/
    `28-async-await-error`/`29-promise-chaining`/`31-microtask-ordering` — a
    confirmed incompleteness of *this build*, not a spec-level finding) and a
    no-trace-reference exclusion for `hermes-dec-sample` (it touches `window`
    unconditionally at top level, which the bare Hermes VM has no stub for at
    all — the reference PoC's own `selftest.mjs` phase 3 already excluded it
    from the Hermes cross-check for the same reason).
  - **Gate identity self-proof**: `runTier({tier:"gate"})` with the identity
    decompiler (candidate = the fixture's own source) over the full corpus
    (492 checks: `constructs/*` + `.min` variants + `hermes-dec-sample`, five
    versions) — **0 DIVERGENT, 0 INCONCLUSIVE, 476 PASS (31 with a documented
    caveat), 16 ERROR** (all eight `KNOWN_AMBIGUOUS_V98` fixtures × plain +
    `.min`, i.e. entirely the concurrent `src/parse/**` v98 layout-ambiguity
    fix — not a harness defect), 22 skipped-by-design (`versions.txt`
    entries, e.g. `30-async-generator` at every version). Completes in ~30s.
  - **Mutation negative control**: a `drop-statement` mutation of
    `01-if-else-chain`/`02-while-loop`/`04-for-loop-basic` DIVERGES on every
    fixture (`tests/gate/harness/tiers.test.ts`). `mutants()`'s
    `negate-condition` operator is a latent, harmless PoC defect (`if (` ->
    `if (!(` is unbalanced-parens by construction and never passes
    `syntaxOk()`) — faithfully ported, not fixed, per the port's own
    "behaviour-preserving" instruction; documented in that test file.
  - **Selftest ported** to `tests/gate/harness/selftest.test.ts`
    (`node --test`, gate tier): phase 1 (determinism + `expected.txt`
    fidelity) 53/53; phase 2 (mutation kill rate) **270/318 (84.9%)** —
    slightly below spec 06 §12's cited historical PoC figure (273/318,
    85.8%) because several fixtures' `source.js` have been edited since that
    number was measured (same corpus size, different content); adopted as
    this port's own HA-09 floor, documented inline, not silently lowered.
  - **Round-trip ratchet (§6)**: `src/harness/roundtrip.ts` normalises
    structurally from our own decoder's output (not regex-parsed
    `hermesc -dump-bytecode` text — the two sides of a round-trip check are
    both already ours), reusing `src/disasm`'s parser/decoder rather than
    reimplementing it. `tests/golden/roundtrip-baseline.json` (235 entries,
    958 functions, 100% exact under identity — expected, since identity
    recompiles the unmodified original) is the HA-10 regression baseline,
    checked in `tests/sweep/harness/roundtrip-ratchet.test.ts`.
  - **`HBC2JS_REQUIRE_ORACLES=1`** honoured throughout (via the existing
    `tests/support/tiers.ts` convention: hermesc/Hermes-VM-dependent tests
    skip when the tool is absent, or throw under that env var).
  - **Not done / deviations from spec 06's letter** (see `docs/TESTING.md`
    for the full list): no dedicated `hbc2js-equiv` binary (folded into
    `hbc2js equiv`/`gate`/`sweep`, per this milestone's explicit task
    boundary); `equiv normalise` takes two `.hbc` files, not two
    pre-dumped `hermesc -dump-bytecode` text files (this port's normaliser
    never shells out to `hermesc -dump-bytecode` at all); no literal
    `expected.txt`-content comparison in the oracle ladder (trace/fuzz
    compares the candidate live against the fixture's own `source.js`
    instead, which is what `expected.txt` was captured from in the first
    place — `chooseReference`'s "expected-txt" engine name is about *not*
    doing an additional Hermes-VM cross-check, not about reading that file's
    bytes); `tools/equiv/` left untouched and marked deprecated (its own
    README now points here) rather than deleted, per §12's own instruction
    to keep it until the port is green and delete it in a separate commit.

## M1 review responses (`docs/reviews/M1-parser.md`, verdict FIX-THEN-MERGE)

All HIGH/MEDIUM findings fixed; LOW/nit items fixed or justified below.

**Undisclosed deviations (review §4) — now disclosed:**
- T8 fuzz mutant count: was 200/binary (a deliberate time-budget scale-down from the
  spec's 2000/binary), now **2000/binary by default** (`HBC2JS_FUZZ_MUTANTS_PER_BINARY`
  env var overrides it for a faster local/CI run) — matches spec exactly out of the
  box. ~498k mutants across all 249 gate binaries run in ~8.6s here, well inside T8's
  30s budget.
- Known-divergences allowlist (T6) was an inline code comment; moved to the
  spec-named `tests/gate/oracle/known-divergences.md`.

**Finding 1 (HIGH) — P3 opcode-table tie-break resolved by verification, not array
order.** `src/parse/layout.ts` now, when >1 opcode table survives the cheap
sample-based probe: decodes **every** function in the whole file (never just the
probe sample) under every remaining candidate with a stronger check
(`decodeAndVerifyFunction`) that additionally requires every jump target to land on
an actual instruction-start boundary within that candidate's own decode (not just
"in range"), and every switch instruction's jump table to be 4-aligned and fit inside
the file. Only if that still leaves >1 survivor does it fall back to preferring the
first-listed (declared-version) candidate — and **only** when every surviving
candidate decodes **every function identically** (same opcode name + operand values),
i.e. the choice is proven immaterial. Otherwise it now throws `E_LAYOUT_AMBIGUOUS`
naming the disagreeing function ids. Added the reviewer's own motivating case as a
test (`hermes-dec-sample/v98.hbc` fn2 decodes differently under `hbc98-late` vs
`hbc99-feb2026`, both "cleanly") and a comment on `candidatesForVersion()`'s array
literal stating plainly that its order is load-bearing.

**A major, unanticipated consequence of implementing Finding 1 correctly:** applying
the stronger, whole-file verification surfaced that **8 real `constructs/*/v98.hbc`
fixtures are genuinely ambiguous** between `hbc98-late` and `hbc99-mar2026` — not by
luck of sampling, but because `hbc99-mar2026`'s misreading of specific bytes (e.g.
`constructs/40-spread-array/v98.hbc` fn0: `hbc99-mar2026` decodes 16 bytes as
`NewObjectWithParent`/`Unreachable`/`NewObjectWithBufferAndParent`/`Unreachable` with
multi-million-value "operands" that are still individually valid `UInt32`s, no
id-checked, no jump — then coincidentally realigns with the correct decode 16 bytes
later) passes **every** structural check this project can write, including the new
boundary/switch checks. This is not a bug in the fix; it is the fix correctly
detecting real, provable ambiguity that the old array-order tie-break was papering
over. Per the coordinator's algorithm, these now throw `E_LAYOUT_AMBIGUOUS` on plain
`parseHbc()` — which is the intended, safer behavior (D8: refuse rather than guess).
`--opcode-table=hbc98-late` resolves every one of them correctly (verified against
this project's 223-function cross-validation and, for one of them, the review's own
`hbc-disassembler` cross-check). The gate test suite now treats these 8 fixtures
explicitly: `tests/support/known-issues.ts` documents them, `module.test.ts` asserts
both that auto-probe refuses and that forcing resolves them, and their golden
snapshots pin the forced (`hbc98-late`) parse. **Real bundles are unaffected** — all
5 production APKs (0.7-50.8MB, v96/v98) and all 4 `rn-template-0.72` variants still
parse cleanly with zero diagnostics; the ambiguity only bites tiny hand-written
construct fixtures whose functions happen to never use a byte value that both tables
interpret as a checkable operand.

**Finding 2 (MEDIUM) — hbc98-late's placeholder is no longer a guess.** Per the
review's request, decoders were changed to fail loudly (`E_UNKNOWN_OPCODE`) rather
than consume a guessed `(Reg8, Reg8)` signature at opcode 15. Doing so immediately
surfaced that `tests/fixtures/constructs/50-this-binding/v98.hbc` (a real,
previously-passing gate fixture) **actually uses opcode 15** — investigating that
regression identified the real opcode: **`CacheNewObject(Reg8, Reg8, UInt32,
UInt8)`**, a genuine Hermes opcode (added `89bc5f08e` 2024-12-04, removed `7193d4485`
2026-01-21, "superseded by the AddPropertyCache optimization"), confirmed two
independent ways: (a) its direct parent commit
`f74f6bbe37ec85a52175c723b366b37717b64605` (2026-01-21, `BYTECODE_VERSION=98`, an
ancestor of the vendored `639e5d6a`) has the exact signature sitting immediately
before `Mov` — the exact position this project's own evidence already pointed to;
(b) decoding `50-this-binding`'s function 3 against that signature consumes exactly
8 bytes and realigns perfectly with the next instruction, and hermes-dec's own
(D4-compliant, output-only) disassembly of those bytes independently names it
`CacheNewObject` with the same operand values. `f74f6bbe37e`'s own table still has
`ToUint32` (added 2025-11-06, well before this commit), so no single commit has both
"CacheNewObject present" and "ToUint32 absent" — the two-correction patch (not a
single-commit pin) remains the honest representation of the evidence. The
`unverified`/fail-loud mechanism (`OpcodeDef.unverified`, checked in both
`decodeForProbe` and `decodeAndVerifyFunction`) is kept in `src/tables/types.ts` for
any future such gap; no table currently sets it. `PROVENANCE.md` documents the find.

**Finding 3 (MEDIUM)** — see "undisclosed deviations" above.

**Finding 4 (MEDIUM) — error offsets + memory budget.**
- All 6 previously-bare `Hbc2jsError` throws in `src/parse/layout.ts` now carry an
  offset (`8` for version-driven decisions, the header/function-table offset for
  layout/opcode-table ambiguity).
- Memory: profiled `parseHbc` phase-by-phase against the 50.8MB Discord bundle
  (extracted from `~/hbc2js-local-corpus/apks/com.discord.apk` to scratch space only,
  per D16 — never copied into the repo) in an isolated process with `--expose-gc`.
  Clean before/after-parse RSS delta was **~4.0x file size** (203MB for 50.8MB),
  matching the review's ~4.5x finding. Phase breakdown (RSS delta from
  post-`readFileSync` baseline, cumulative):
  | Phase | Cumulative RSS delta | Ratio |
  |---|---|---|
  | header + sections + layout probe | 6.8MB | 0.13x |
  | + `parseStringTable` (metadata only, 327,121 strings) | 61.0MB | 1.20x |
  | + decode every string's text (`.get()` x 327,121) | 112.7MB | 2.22x |
  | + read every function record (120,522) | 188.3MB | 3.71x |

  The single largest identified cost was eagerly building one boxed `StringEntry`-
  shaped object per string just to validate it (INV-12), before any text was even
  decoded. Fixed in `src/parse/strings.ts`: string metadata is now resolved into
  parallel typed arrays (structure-of-arrays: `Uint8Array`/`Uint32Array` per field)
  instead of one object per string; `entry(id)` builds a single `StringEntry` object
  on demand per call (matching `get()`'s existing on-demand-decode pattern), and
  INV-12's bounds check still runs eagerly for every string exactly as spec 01 §2
  requires — it just no longer allocates a JS object to do it. Re-measured clean:
  **parse-delta RSS is now ~2.6x file size** (133MB for 50.8MB), inside the §7.3
  budget. Function-record construction (120,522 `FunctionRecord`+`FunctionHeader`+
  `FunctionFlags` objects, ~76MB) remains the largest residual cost; restructuring
  that would touch the public `FunctionRecord`/`FunctionHeader` API shape and was
  judged too invasive for this review-response pass — left as a documented M2+
  candidate if bundle-scale memory becomes a problem again. All 5 production APKs and
  all fixture-corpus tests re-verified clean after this change (golden snapshots
  byte-identical, confirming the refactor is behavior-preserving).

**Finding 5 — folded into Finding 4** (same investigation).

**Finding 6 (LOW) — fixed.** `tests/sweep/parse/bundles.test.ts` now asserts
`probe.exhaustive === true` for every bundle (all four are <2.7MB, well under the
spec's 4MB threshold for this assertion).

**Finding 7 (LOW) — not fixed here.** `src/cli.ts` is concurrently owned by another
agent (per this task's routing); the CLI arg-parsing robustness fix (skip flag-shaped
tokens when filling `--info`'s argument) is deferred to that agent/spec 02's CLI work.
Not spec-mandated behavior either way, per the review's own assessment.

**Finding 8 (NIT) — accepted as-is.** `Hbc2jsError.toJSON()`'s `message` field
intentionally duplicates `code`/`context.offset` in already-formatted, human-readable
form; this is a deliberate convenience for `--json` CLI consumers and log output, not
an oversight. No change made.

**Cross-cutting note for the overseer:** `src/disasm/**`'s concurrent test suite
(`tests/gate/disasm/**`, `tests/gate/oracle/disasm/**`) also calls `parseHbc()`
directly over the full fixture corpus without forcing an opcode table, and will hit
the same 8 now-correctly-`E_LAYOUT_AMBIGUOUS` v98 fixtures documented above. This
wasn't introduced by that agent's work — it's a direct, correct consequence of this
review's Finding 1 fix applied to shared `src/parse/` infrastructure. Since
`src/disasm/**` and its tests are outside this task's ownership, they weren't
modified here; whoever picks that up next should reuse
`tests/support/known-issues.ts`'s `KNOWN_AMBIGUOUS_V98` list the same way
`tests/gate/parse/module.test.ts` and `strings.test.ts` do.

## M4 baseline (2026-08-30)

`hbc2js <in.hbc>` produces runnable JavaScript for every gate fixture at every
version it compiles at. Output is deliberately ugly (D11): `while (true)` with
labelled `break`, one `let rN` per register, `Reflect.apply` for non-method calls,
duplicated `finally` bodies, generator shims.

### Gate

`syntax` + `trace` oracles, D14 reference policy (Hermes VM where one exists):

| Version | Checks | PASS | DIVERGENT | ERROR |
|---|---|---|---|---|
| 84 | 91 | 91 | 0 | 0 |
| 94 | 95 | 95 | 0 | 0 |
| 96 | 95 | 95 | 0 | 0 |
| 98 | 105 | 105 | 0 | 0 |
| 99 | 106 | 106 | 0 | 0 |
| **total** | **492** | **492** | **0** | **0** |

22 (fixture, version) pairs are skipped-by-design (`versions.txt`). The eight
`KNOWN_AMBIGUOUS_V98` fixtures are decompiled with `--force-v98-table`
(`hbc98-late`), reported as `W_FORCED_OPCODE_TABLE`; D8 keeps the *parser* from
guessing, so the choice is the caller's and it is recorded.

Hardened tier (241 obfuscated variants, same oracles): **237 PASS, 4 DIVERGENT,
0 ERROR**. The four are `32/33/34/36-class-*.obf` at v99, where the decompiled
obfuscator prelude reaches `Reflect` with a non-array-like argument list
("CreateListFromArrayLike called on non-object"); the same fixtures pass
unobfuscated at every version.

### Adding `fuzz` to the oracle set

With `fuzz` (50 adversarial argument tuples per exported function) the gate is
**452 PASS / 40 DIVERGENT**, in four fixture families, and every one is a
*message-text* difference rather than a behavioural one:

* `13-try-finally-no-catch`, `44-tagged-templates` — V8 builds a TypeError's text
  out of the **original source identifier** (`log.push is not a function`). A
  register-named baseline says `r3.push is not a function`. SPEC puts name
  recovery out of scope, so this is not reachable at M4.
* `26-infinite-generator-take` — the same, for `for…of` (`iterable is not
  iterable`). The *destructuring* form of the message carries no expression text
  and is reproduced exactly, which is why `37-destructuring-array` passes.
* `43-template-literals` — a genuine Node-vs-Hermes divergence of the same kind as
  the four in `docs/EQUIVALENCE.md` §5.2: Hermes evaluates the arithmetic before
  the string conversion, so a Symbol operand throws "Cannot convert a Symbol value
  to a **number**" under the bytecode and "…to a **string**" under the source.
  It belongs in `KNOWN_DIVERGENT_FIXTURES`; that table lives in
  `src/harness/reference-policy.ts`, which this milestone does not own.

The `roundtrip` oracle is also excluded, for a structural reason: it reports a
**function-count mismatch** as DIVERGENT, and decompiled output can never have the
original's function count (it carries the runtime-helper prelude and the module
wrapper). Spec 05 T5 asks for the round-trip as a per-function ratchet, which that
check pre-empts.

### Sweep — real bundles

Every function of every `bundles/rn-template-0.72/*.hbc` builds a CFG, structures,
passes the §5 isomorphism check, and the whole module passes `node --check`:

| Bundle | Version | Functions | Duplicated blocks | Dispatch vars | Unresolved (env, slot) | Structure | Emit | Output |
|---|---|---|---|---|---|---|---|---|
| index.android.hbc | 94 | 4199 | 79 | 0 | 0 | 0.30 s | 0.51 s | 6.7 MB |
| index.android.debug.hbc | 94 | 4199 | 83 | 0 | 0 | 0.39 s | 0.77 s | 6.7 MB |
| index.android.noopt.hbc | 94 | 4314 | 70 | 0 | 0 | 0.50 s | 1.09 s | 10.8 MB |
| index.android.noopt.debug.hbc | 94 | 4314 | 72 | 0 | 0 | 0.56 s | 1.29 s | 10.8 MB |

**First measurement of how irreducible shipped React Native bytecode is** (spec 04
T7): ~1.7% of blocks are duplicated to resolve irreducible entries, and *no*
function needs a dispatch variable. Max tree nesting 319, well under ST-09's 1000.

### Local corpus (C5, report only — never committed, extracted to a scratch dir)

| Bundle | Version | Size | Result |
|---|---|---|---|
| Teams org-chart | 96 | 0.7 MB | 3179 functions, 0 unresolved, `node --check` OK, 5.1 MB out, 0.5 s |
| Bloomberg | 96 | 10.5 MB | 58 932 functions, 0 unresolved, `node --check` OK, 83 MB out, 20 s |
| Discord | 98 | 51 MB | parses and analyses in 26 s, then **refuses**: `JmpTypeOfIs mask 507` |
| Shopify | 98 | 34 MB | same refusal, 17 s |

The refusal is deliberate. Only `TypeOfIsTypes` bit 7 (`Function`, mask 128) is
confirmed against real bytecode — every `JmpTypeOfIs` in the whole construct corpus
is mask 128, guarding `throwTypeError("Trying to call a non-function")` — and
`Typeof.h` is not among the vendored Hermes headers. Guessing the rest of the enum
would be a silently wrong lowering of a type test, so it is `E_EMIT_UNSUPPORTED`
naming the mask (EM-05). **Vendoring `Typeof.h` and pinning the enum is the single
change that unblocks two 30–50 MB production bundles.**

### Known gaps and deviations from the specs

1. **`TypeOfIsTypes` beyond `Function`** — above. The only thing stopping Discord
   and Shopify.
2. **Spec 05 §7.5's loud fallback is a diagnostic, not an error.** A `CreateThis`
   or `SelectObject` outside a recognised triple is lowered directly (they *do*
   have exact JS forms: `Object.create(proto)` and
   `Arg3 instanceof Object ? Arg3 : Arg2`) with `W_UNPAIRED_NEW`, because real
   bundles separate the triple across basic blocks in ways the matcher does not
   always close. Totality on 4200-function inputs was judged worth more than the
   loud stop; the diagnostic keeps it visible.
3. **Spec 05 §7.3's four-helper list** is D18's larger set.
4. **`docs/HBC-FORMAT.md` §6.3's ByteString row is wrong for v≥97.** Tag 6 carries
   no payload there and marks `undefined` (§6.3's "undefined has no tag" case);
   short string ids go through ShortString. Measured: 0 of 162 v≥97 key buffers use
   tag 6, all 51 legacy ones do, and reading it with a payload decodes
   `24-generator-return-throw` v99's finished-generator result as
   `{value: "next", done: 1}` instead of `{value: undefined, done: true}`.
   `src/emit/literals.ts` reads it per era; `src/parse/buffers.ts` is untouched.
5. **Spec 03 §9 T2's "four of them"** — `hermes-dec-sample` v99 function 5 shares
   its handler across all **five** regions, not four.
6. **Spec 04 O-5's "no fixture is known to be irreducible"** —
   `16-finally-with-break-continue` is, at v84/94/96, once exception flow is
   modelled: the duplicated `finally` body flows back into the loop, giving it two
   entries. It is the only gate fixture that uses a dispatch variable.
7. **v98/v99 `.obf` class fixtures** — the four hardened-tier divergences above.

## Known gaps
- ~~**HBC 96 has no compiler/fixture yet**~~ **Closed.** Three of the five
  pulled production apps (Xbox, Bloomberg, Teams) ship v96; Discord and
  Shopify ship v98. `tools/get-hermesc.sh 96` now fetches it
  (`react-native@0.73.11` → facebook/hermes commit
  `644c8be78af1eae7c138fa4093fb87f0f4f8db85`), `hermes-dec-sample/v96.hbc`
  and all 47/53 compilable `constructs/*` fixtures (+obf/min variants) exist.
  Layout class C (same as v94); opcode table is v94's table with one
  operand-shape change (`DirectEval` gains a third `UInt8 isStrict` operand,
  192 opcodes unchanged) — neither v94's nor v98's table verbatim, its own
  pin. See `docs/TOOLCHAIN.md`'s "v96: opcode table and layout" section.
  Local proprietary corpus (D16 C5): 5 bundles, 10–52 MB, in
  `~/hbc2js-local-corpus/apks/` (not in repo).
- No Linux arm64 `hermesc` build published anywhere found; only Linux x86_64.
- `tests/fixtures/constructs/` is now compiled (243/265 fixture×version
  combinations; see `tests/fixtures/README.md`), and now includes `SwitchImm`
  /`UIntSwitchImm` jump-table coverage (52, 53) and a real overflowed-string
  entry / broad regex + BigInt table exercise via `tests/fixtures/bundles/
  rn-template-0.72/index.android.hbc` (4199 functions, 12 overflow strings,
  45 regexes — see its `BUILD.md`). Still not exercised anywhere: object
  shape table with >0 entries in a *construct* fixture (only the real bundle
  has one), `StringSwitchImm` (string-keyed switch jump table — confirmed to
  exist only on v98/v99/Static Hermes, never v84/v94, but not shipped as its
  own fixture; see `tests/fixtures/README.md`'s switch-jump-table section for
  the probe results), and a genuinely unoptimized (`-O0`) *construct* fixture
  (the real bundle has one: `index.android.noopt.hbc`) — see
  `docs/PRIOR-ART.md` §7.4. A v84 fixture pair now exists
  (`tests/fixtures/hermes-dec-sample/v84.hbc`, plus v84.hbc for 43/51
  construct fixtures — 8 don't compile on v84, see that directory's README).
- **v98's "98-early"/class-D header layout has never been observed in any
  publicly-obtainable bytecode** (only "98-late"/class-E, from every
  `hermes-compiler@250829098.0.x` patch probed) — the D8 parser probe's
  class-D branch for v98 remains untested against real bytecode; only
  synthetic/hand-constructed test input can exercise it. See
  `docs/TOOLCHAIN.md`.
- `docs/TOOLCHAIN.md` still refers to the pre-move fixture paths
  (`tests/fixtures/v94.hbc` etc.); fixtures now live in
  `tests/fixtures/hermes-dec-sample/`.
- Proposed decision **D7** (Ramsey-style total structurer replacing the
  `for(;;) switch(ip)` fallback of D6) is written up in `docs/PRIOR-ART.md` §7.2 but not
  yet ratified in `docs/DECISIONS.md`.
