# Project status

Last updated: 2026-08-30

## Milestones
- [x] M0 Research: toolchain (`hermesc` locally), prior-art survey, test corpus candidates
- [x] M1 Parser: header (all 5 layout classes), section walk, string table, function
      headers (small+large, both eras), exception handlers, debug offsets, literal
      buffers, object shape table, BigInt/RegExp/CJS/functionSource tables, D8 layout
      probe (P0–P4), opcode/builtin table generation — v84/94/96/98/99 fixtures.
      Instruction decoding itself is spec 02 (M2), out of scope here.
- [ ] M2 Disassembler + diff test against hermes-dec output
- [ ] M3 Test harness: sandboxed trace runner (D2) + recompile round-trip (D3)
- [ ] M4 Baseline: CFG + Ramsey structurer + emitter (with D9 shim) → **every** fixture passes the equivalence gate, ugly output allowed (D11)
- [ ] M5 Pass ladder: one construct fixture per iteration as matcher/writer/checker pass (D12), catalogue row per pass; track `N/51 recovered` here
- [ ] M6 CLI + Tier 2 sweep (D13): RN template bundle and Expensify-scale bundle survive; recompile round-trip clean

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
- Otherwise: no parser/CLI code yet.

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
