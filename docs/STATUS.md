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
- [x] M4 Baseline: CFG + Ramsey structurer + emitter (with D9 shim) — **MERGED** after the adversarial review (`docs/reviews/M4-baseline.md`, verdict FIX-THEN-MERGE) and its response. **501/501 gate checks PASS, 0 DIVERGENT, 0 INCONCLUSIVE, 0 ERROR** under `syntax` + `trace`, at v84/94/96/98/99 — and the gate now runs the *real* decompiler on every `npm test`, not the identity stand-in. See the M4 section below.
- [ ] M5 Pass ladder: one construct fixture per iteration as matcher/writer/checker pass (D12), catalogue row per pass — **3/53 recovered** (`while`, `do…while`, `for`).
  - Framework landed (D12/D12a): `src/passes/{types,registry,driver,tree,catalogue,index}.ts`, the one-page contract in `src/passes/README.md`, `--no-pass <name>` / `--passes=none` / `--list-passes`, and the pipeline wired between the structurer's tree IR and emit. Per-site abandonment per D12: a failed `check`, or a splice that fails spec 04 §5's whole-function `reconstruct`+`checkIsomorphic` round-trip, leaves that site as the M4 shape and records a `W_PASS_ABANDONED` diagnostic — it never aborts the function. PL-01/03/04/05/06/07/08 have gate tests; PL-06 fails a pass whose catalogue row is ⛔, missing, or `✅ single-version`; D12a's import boundary is enforced by `tests/gate/passes/imports.test.ts`.
  - Pass 1 `loop-cond` (catalogue rows 2, 3) — `while (true) { if (!c) break; B }` → `while (c) B`, tail guard → `do { B } while (c)`, including the tail-labelled shape where the structurer nested the loop's exit code inside it. Pass 2 `for-header` (row 4, `after: ["loop-cond"]`) — `for (init; c; step)` when the init is the tail of the block that falls into the loop and the step is the tail of the body's last block; it also owns the `do…while` → `while` promotion, which fires only when `firstTestHolds` proves the folded pre-test was statically true (that proof is re-run in `check`, because an annotation-only rewrite gets no help from the round-trip). Deciding this in `loop-cond` instead — the first cut — made fixture 03's genuine `do…while` print as `while` at v96/98/99 but not at v84/94, purely because of register allocation.
  - Corpus effect: **1,573 sites rewritten, 0 abandoned** over `tests/fixtures/constructs/**` (all five HBC versions × base/`.min`/`.obf`) — 1,487 `loop-cond` + 86 `for-header`, touching 52 of the 55 construct fixtures. Gate: **889/889 tests, 501/501 fixture checks PASS**, 0 DIVERGENT/INCONCLUSIVE/ERROR, with passes on; `--passes=none` is still byte-identical to the M4 baseline (PL-05).
- [ ] M6 CLI + Tier 2 sweep (D13): RN template bundle and Expensify-scale bundle survive; recompile round-trip clean

## Queued next (after current agents)
- **Review PR #11** (T9 part 1: fixtures 55/56 + `src/disasm/print.ts` StringSwitchImm fix): reviewer agent on `gh pr diff 11`; verify 7.A (hermesc dump) and 7.B (hermes-dec) match on the new fixtures at all versions and that existing goldens are unchanged; merge on MERGE + green `npm test`. Next free slot.
- **CI fix #2 — fixed** (2026-08-30, Claude Sonnet 5): CI was red on 54e077c — `build-test` set `HBC2JS_REQUIRE_ORACLES=1` without installing hermes-dec, failing 7.B (`hbc-disassembler diff`) and `hbc-file-parser cross-check`; `oracle-hermes-dec` had hermes-dec but never ran `tools/get-hermesc.sh`, failing 7.A, the round-trip oracle, and `hbc2js gate scores the real decompiler by default`. Decision: install *both* oracle classes in *both* jobs rather than dropping `REQUIRE_ORACLES` anywhere, so it keeps meaning "every oracle this job's tests can reach is present and enforced" in each job — `build-test` gained `actions/setup-python` + `pip install -r tools/oracles/requirements-hermes-dec.txt` (new pinned-version file, cache: pip); `oracle-hermes-dec` gained the same `actions/cache`-backed `tools/get-hermesc.sh all` step `build-test` already had. `review-M4-C1`'s Hermes-VM check keeps skipping INCONCLUSIVE everywhere (no workflow builds `tools/hermes-vm/**`, unaffected by this fix, already correct per the prior CI fix above). The T8 fuzz test (`2000 deterministic mutants`) was checked against the latest failed run (33309570512) and is **not** failing — it passed in ~45-55s under `HBC2JS_TIME_SCALE=2.5` in every job that reached it; no change needed. Verified locally: targeted run of `tests/gate/oracle/**`, `tests/gate/harness/roundtrip.test.ts`, `tests/gate/decompile/review-M4-C1.test.ts` and the new docs test — 529/529 pass under `HBC2JS_REQUIRE_ORACLES=1` with both `hermesc` and `hermes-dec` on PATH. Also added `tests/gate/docs/decisions-headings.test.ts` (issue #1 follow-up): fails on duplicate `## Dnn` heading ids in `docs/DECISIONS.md`.
- **Deps: add a `hint` tier** — single-evidence leads (e.g. native-module name only) reported separately from `guessed` (which requires ≥2 evidence kinds), so Discord/Shopify keep their 13–15 native-module leads without over-claiming. Overseer decision 2026-08-30 after deps-v1 review.
- **CI — fixed** (2026-08-30, Claude Sonnet 5): `review-M4-C1 applyWithGuard vs Hermes VM` now skips INCONCLUSIVE (not throw) when `tools/hermes-vm/v94` is absent, even under `HBC2JS_REQUIRE_ORACLES=1` — `tests/support/hermesvm.ts`'s `requireHermesVm` no longer honours that flag, since (unlike `hermesc`, which `ci.yml` always fetches) the source-built VM is never provisioned by any workflow (docs/TOOLCHAIN.md: local-only cmake build), matching the existing `findHermesVm`-plus-skip convention in `tests/gate/harness/reference-policy.test.ts`. Timing budgets (gate's 120 s wall-clock, its 8 s per-fixture trace-oracle timeout, and sweep's T9 parse-budget) now scale by `HBC2JS_TIME_SCALE` (default 1; `ci.yml` and `sweep.yml` both set 2.5) via `tests/support/tiers.ts`'s `timeScale()` — fixes the two Linux timing-budget failures seen on `deb` and reproduces/fixes `sweep.yml`'s "log not found" failure (T9 in `tests/sweep/parse/bundles.test.ts` flaking its unscaled pro-rata parse budget under load, confirmed locally). Note on `ci.yml`'s `concurrency.cancel-in-progress: true`: kept as-is (superseded pushes should cancel); a run showing "Cancelled" in that workflow is a superseded run, not a failure — don't triage it as one.
- **D17c bulk signature build — RUNNING on `deb`, first check-in done** (started 2026-08-30, Claude Sonnet 5; checked in 2026-08-30, Claude Sonnet 5, `docs/PACKAGE-SIGNATURES.md` §6): `tools/pkgsig/bulk/packages.json` (2,998 packages, 13,319 package@version selections, ~4.4 versions/pkg spanning 2022-2026) and `tools/pkgsig/bulk/run.sh` are committed. Node 22 (fnm) + `tools/get-hermesc.sh all` installed on `deb`; `npm test` on Linux is 548/550 (2 perf-budget-only failures, not decompiler bugs — see AGENT-LOG). Two Metro scaffolds (RN 0.72.17 -> HBC94/96, RN 0.87.1 -> HBC98/99), 16 cloned slots each, drive `~53,300` (package, version, hbcVersion) build jobs at 16-way parallelism (`xargs -P 16` + a flock-based slot semaphore), each `npm install <pkg>@<version> --ignore-scripts` (never runs package code) -> Metro bundle -> matching `hermesc` -> fingerprint -> write into `~/hbc2js-bulk/db/` (D17c/schema-2 format, resumable — skips anything already on disk). **Check-in @ 2026-08-30 15:54 UTC**: 23,046/53,276 jobs (43.3%), ok=15,727, fail=7,319 (31.8%, all in the expected classes plus one new transient `ENOBUFS`-under-load class, harmless/self-healing — see §6.2), ~77 jobs/min, ETA ~22:20-22:30 UTC same day. DB 3.1 GB on disk, host has 85 GB free. Process alive throughout, not restarted. **Check progress**: `ssh deb '~/hbc2js/tools/pkgsig/bulk/run.sh status'` (also `... failures` for recent failure reasons). New: `tools/pkgsig/bulk/assemble.sh` (idempotent, safe to run mid-build) packages whatever exists into `~/hbc2js-bulk/dist/sigdb-<date>-partial.tar.zst` + a package/version/hbcVersion `index.json`; first run produced a 348 MB archive from the 3.1 GB partial DB. **Coverage measurement (important negative result, §6.4)**: layering this partial archive into `hbc2js deps --sigdb` for `rn-template-0.72`/`react-navigation-example-0.85.3` barely moved module-attribution % (97.7%→97.9%, 57.8%→57.6%) but ballooned `confirmedDeps` into thousands of clearly-wrong package matches (`pg-int8`, `text-hex`, …) — root cause: `build-one.mjs` never applies §5.2's foundation-subtraction (react/react-native/toolchain-baseline hash removal) the curated shared DB gets, so ~15k files each carry an unsubtracted copy of shared boilerplate that collides across unrelated packages. **This partial archive must not be fetched/layered into a real sigdb yet** — subtraction (post-process over `db/`, or built into `build-one.mjs` going forward) is required first. `tools/pkgsig/fetch-db.sh` (new stub, `HBC2JS_SIGDB_URL`-driven) exists for whenever a subtracted archive is actually published. A later short agent: let the run finish, apply foundation subtraction, republish, re-measure coverage. Loop ticks: only glance at the log, never relaunch the run while it is alive.
- **README "Tested on real apps" table** once the M4 fixes land: one row per corpus app — name, app version, HBC version, bundles × size, level reached (parse / disasm / decompile+`node --check` / deps extracted / round-trip %), date, hbc2js commit. Metadata only; never any app content. Keep it regenerable from a script (`tools/sweep-corpus.mjs --readme`) so it stays honest.
- **Linux verification on `deb`** (ssh host `deb`, Debian/Ubuntu x86_64, 32 cores, 31 GB, Node 18 → install Node 22 user-space via fnm, ~117 GB disk free after cleanup): clone, `tools/get-hermesc.sh all`, `npm test`, `test:all`, `hbc2js gate`, `build-hermes-vm.sh 94`; fix any portability bugs found; record timings. This box may also be used for heavy work (Hermes builds, Expensify/Discord sweeps) — never copy the local proprietary corpus onto it.
- **Deps review (medium, Sonnet)** as soon as `hbc2js deps` lands: (a) code works — re-run offline gate + seed results independently, adversarial matcher tests (absent package, wrong version, same package two versions); (b) architecture sound — evidence scoring, confirm loop, DB layering, robustness to a new RN version. Verdict MERGE / REFACTOR / REWRITE; only not-sound triggers an architect spec (`08-deps.md`) and rework.
- **On-device round-trip (D16a) — DONE** (2026-08-30, Claude Sonnet 5, tablet `HA2APYTS`): `tools/device-roundtrip.sh [--app <dir>] [--variant js|hbc]` scaffolds a throwaway RN 0.72.17 app (`App.tsx` exercising a counter, a loop-built list, a generator, an async function, try/catch/finally, each step logging a `console.log` marker), builds a release APK (Hermes on, debug-signed), installs+launches+taps it on the attached device, extracts `assets/index.android.bundle` (HBC 94), decompiles with this repo's own `node src/cli.ts`, repackages the APK with either the decompiled JS as-is (`--variant js`, the default — Hermes compiles plain JS at load, no recompile needed) or that JS recompiled back to bytecode via `tools/hermesc/v94/hermesc -O` (`--variant hbc`), re-signs with the debug keystore (zipalign + apksigner), and repeats install+launch+tap. Result: **both variants' `ReactNativeJS` logcat output is byte-identical** to the original build (after stripping timestamps/pids) and **screenshot RMSE diff is 0.0000%** (full frame and status-bar-excluded content region alike) across the 3-tap interaction sequence. Used `adb input tap` (coordinates resolved live per-run via `uiautomator dump`, not hardcoded) rather than Maestro, to keep the script dependency-light — see docs/DEVICE-TESTING.md for the full writeup, prerequisites (a user-space JDK 17 via `brew install openjdk@17`, since the RN 0.72 Gradle wrapper can't run under JDK 21+ and the task's suggested `--cask temurin@17` needs sudo this agent can't supply), and two device-specific quirks worth knowing before re-running: `adb install` intermittently returns `INSTALL_FAILED_VERIFICATION_FAILURE` and needs a bare retry (scripted, automatic), and this tablet's Play Protect occasionally shows an "unsafe app blocked" dialog that genuinely needs a human tap + device password (not scriptable, not worked around — left to the device owner). `tests/sweep/device/roundtrip.test.ts` runs the script under the sweep tier when a device is attached, INCONCLUSIVE otherwise.
- **D16a used as the M5 per-pass control — PASS with passes ON** (2026-08-30, Claude Opus 5, same tablet `HA2APYTS`): re-ran `tools/device-roundtrip.sh` (default fresh scaffold, `--variant js`, HBC 94) against the current pipeline with the `loop-cond`/`for-header` passes **enabled** — the script calls `node src/cli.ts` with no `--passes=none`, so the installed bundle is the pass-rewritten JS. Result **identical**: `logcat: IDENTICAL`, screenshot RMSE **0.0000% full / 0.0000% content**, exit 0. So the `while`/`do…while`/`for` recovery survives production Hermes in a real RN app, not just the sandboxed oracles. Re-run this per ladder *batch* (not per commit) and record the two RMSE numbers in the batch's review. React-navigation example and headless-AVD CI fallback remain queued, unstarted follow-ups (D16 C6's broader scope).

## Queued before M5
- Measure `npm run test:all` and `hbc2js gate` wall time after M4 lands. If either exceeds ~2 min, parallelise: `node --test --test-concurrency=<cores>` across files, and per-fixture worker pool inside the gate runner (fixtures are independent). Keep a `--serial` escape hatch for debugging. Record timings here.
  - Measured 2026-08-30 19:15 after M4: `npm test` (gate) = 69 s wall, 5.7 cores busy — node's runner already parallelises across files. `test:all`/`hbc2js gate` timings pending (M4 reviewer to record).
  - Re-measured after the M4 review response, with the real decompiler's 501-check equivalence run *inside* the gate: `npm test` (855 tests) = **88 s**, `npm run test:all` (855 + 20) = **118 s**, `hbc2js gate` = **49 s**. It got *faster* despite the added run because `syntaxOk` stopped spawning `node --check` per candidate and compiles with `vm.Script` in process (review timing win 1, ~33 s). `test:all` now runs the two tiers sequentially — sharing one `node --test` invocation made the gate's 7-worker pool compete with the sweep's wall-clock budgets. Timing wins 2 (worker pool for the 7.B disassembler diff) and 3 (`--test-concurrency`) are still unspent and not yet needed.

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
| 94 | 97 | 97 | 0 | 0 |
| 96 | 97 | 97 | 0 | 0 |
| 98 | 107 | 107 | 0 | 0 |
| 99 | 109 | 109 | 0 | 0 |
| **total** | **501** | **501** | **0** | **0** |

(492 before the review response; the two new regression fixtures
`54-try-catch-finally-shared-range` and `55-typeof-is-masks` add nine checks.)

**The gate runs the real decompiler.** Until the review, `hbc2js gate` and
`npm test` both scored the *identity* decompiler — the command the docs pointed
at contained no execution-equivalence check at all, and the real run lived only
in a sweep test `npm test` never executes. `runTierCmd` now passes
`hbc2jsDecompiler` by default (`--identity` keeps the harness self-test,
`--oracles` overrides the set) and the 501-check run is
`tests/gate/decompile/equivalence.test.ts`, asserted on every `npm test`.

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
| Discord | 98 | 53 MB | past `E_ENV_UNRESOLVED` and `JmpTypeOfIs`; now refuses on `PutOwnBySlotIdx` (see below), 10 s |
| Shopify | 98 | 35 MB | same, 9 s |

`Typeof.h` is now vendored and every `TypeOfIs`/`JmpTypeOfIs` mask decodes
(review M4-H2), and `--lenient-env` gets past the 4 018 unresolvable environment
accesses, so both bundles go much further than the M4 baseline's
`JmpTypeOfIs mask 507`. They now stop at a **different** loud refusal:

```
E_EMIT_UNSUPPORTED: slot 0 of r4 has no known object shape at offset 106
```

`PutOwnBySlotIdx` writes to slot *n* of an object's shape, and the emitter only
knows a register's shape when the `NewObjectWithBuffer*` that created it was
lowered in the same pass on the same register. In these bundles the creation is
in another block, so the key is genuinely unknown at that point.
31–37 % of their functions contain a `*BySlotIdx` (Discord 37 889/120 522,
Shopify 35 812/97 752), though only the cross-block ones fail. **Propagating the
recorded shape across blocks/`Mov` is the next thing standing between the CLI and
a 30–50 MB production bundle**, and it is a distinct defect from the two the
review named.

Two operational notes measured on the same runs: peak heap is ~300× the input
(so 53 MB needs `--max-old-space-size=16000`, which `hbc2js` now tells you before
it starts instead of dying in the collector), and Shopify has a function whose
structure tree is deep enough to overflow Node's default stack in `lowerTree` —
`--stack-size=6000` clears it. Neither bundle is committed; both were extracted
to a scratch directory (D16 C5).

### Review response (`docs/reviews/M4-baseline.md`, verdict FIX-THEN-MERGE)

| # | Finding | Status |
|---|---|---|
| **C1** | Identical-range exception regions nested in inverted priority — the `catch` was skipped and the exception went to the `finally`'s rethrow | **Fixed.** `carveRegions` tie-breaks equal ranges by file order *descending* and lets an equal range be a parent. Regression: fixture `54-try-catch-finally-shared-range` at all five versions, a CFG invariant, and RN's own `ErrorUtils` polyfill lifted verbatim out of `index.android.bundle`, compiled with hermesc v94 and compared against the Hermes VM |
| **H1** | `hbc2js gate` / `npm test` scored the identity decompiler | **Fixed.** Real decompiler by default, `--identity` for the self-test, T2 moved into the gate |
| **H2** | Discord/Shopify unreachable through the CLI (OOM, hard-coded `strictEnv`, `JmpTypeOfIs`) | **Fixed** as far as this finding goes — `Typeof.h` vendored, `--lenient-env`, heap guidance. Both bundles now stop on a *different*, newly-visible refusal (object shapes; see the corpus table above) |
| **H3** | No helper had a unit test or a catalogue row (spec 05 §7.1 rule 4) | **Fixed.** `tests/gate/runtime/helpers.test.ts`, one test per helper, plus a "Runtime helpers" table in `docs/LOWERING-CATALOGUE.md`; two ratchet tests fail if a new helper arrives without either |
| M8 / correction 1 | HBC-FORMAT §6.3 tag 6 at v≥97 | **Fixed** in the doc and in `src/parse/buffers.ts` |
| Correction 9 | Spec 04 §4.2's loop-wrapper placement | **Fixed** in the spec (the implementation was already right) |
| M1 | `__hbc_b_spawnAsync` defers a thenable's `then` by one tick vs Hermes ≤96 | **Recorded**, in the helper's catalogue row. Not fixed — it needs the driver to mirror Hermes's own InternalBytecode `spawnAsync` |
| M2, M3, M4, M5, M6, M7, L1–L6 | `SelectObject`, the P8 try-priority property, D18's nominal `Frontend` boundary + duplicate number, the fuzz relax list, the round-trip ratchet floor, the over-reach `[min,max]` premise, printing/label nits | **Not addressed** — queued for M5; none blocks the merge. L2's "16 unexplained ERRORs" turned out to be already asserted: `tiers.test.ts` attributes each one to `KNOWN_AMBIGUOUS_V98` |

Timing win 1 was taken (in-process `vm.Script` instead of a `node --check`
subprocess per candidate, ~33 s), which is what let the 501-check equivalence
run join the gate without the gate getting slower.

### Known gaps and deviations from the specs

1. ~~**`TypeOfIsTypes` beyond `Function`**~~ — **fixed** (review M4-H2).
   `include/hermes/FrontEndDefs/Typeof.h` is vendored for the three pins that
   have the opcode (byte-identical, sha256 in each `VENDOR.yml`) and the bit
   order generated into `src/tables/generated/typeofis-<id>.ts`; pins whose
   commit predates the opcode still have no table and still refuse, so the mask
   is decoded rather than guessed. `55-typeof-is-masks` exercises masks 1, 4, 8,
   16, 32, 64, 128, 258, 383, 503 and 507 against the Hermes VM. The new blocker
   for Discord/Shopify is the object-shape one above.
2. **Spec 05 §7.5's loud fallback is a diagnostic, not an error.** A `CreateThis`
   or `SelectObject` outside a recognised triple is lowered directly (they *do*
   have exact JS forms: `Object.create(proto)` and
   `Arg3 instanceof Object ? Arg3 : Arg2`) with `W_UNPAIRED_NEW`, because real
   bundles separate the triple across basic blocks in ways the matcher does not
   always close. Totality on 4200-function inputs was judged worth more than the
   loud stop; the diagnostic keeps it visible.
3. **Spec 05 §7.3's four-helper list** is D22's larger set.
4. ~~**`docs/HBC-FORMAT.md` §6.3's ByteString row is wrong for v≥97.**~~ — the doc
   is **corrected** (tag 6 = `UndefinedTag`, no payload, at v≥97), and
   `src/parse/buffers.ts` now takes an optional `version` so it can read either
   era (`tests/gate/parse/literals.test.ts`). The original finding, for the
   record: Tag 6 carries
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

## Lane B: dependency extraction, `hbc2js deps` (2026-08-30, D17/D17a/D17b)

**Reviewed 2026-08-30** (`docs/reviews/deps-v1.md`, medium adversarial):
architecture MERGE; report aggregation and `-g` robustness REFACTORed in
place. Ground truth (D17d) now gates: rn-template release and `-g` both
confirm react-native@0.72.17 + react@18.2.0 with 0 false positives at either
tier (was: 12 invented guesses on release, nothing at all on `-g`).
Per-module accuracy 77.3% / 75.2% strict (`docs/DEPS.md`). Confirm stage
still unexercised end-to-end.

Promoted the T8/D17 prototype (`tools/pkgsig/**`, docs/PACKAGE-SIGNATURES.md
§5) into a real, typed `src/deps/**` implementation and a new `hbc2js deps`
CLI subcommand (additive, `src/cli.ts`). Full detail, evidence-weight table,
DB-layering spec and the seed-run numbers: `docs/DEPS.md`.

- **Module inventory** (`src/deps/inventory.ts`, `src/deps/dscan.ts`):
  structural `__d(factory, id, deps)` recovery, no decompilation. Verified
  against the committed `rn-template-0.72` fixture: all 435 Metro modules
  recovered with resolved local ids, dep arrays, and string-constant sets.
- **Match** (`src/deps/match.ts`) against the D17b-layered signature DB
  (`src/deps/db.ts`: project-local `<out>/.hbc2js/sigdb` -> user cache
  `~/.cache/hbc2js/sigdb` (XDG-aware) -> shared `tools/pkgsig/db`, disabled
  by `--no-shared-db`) — same confidence-tier scoring as the v2 prototype,
  ported with baseline-alias handling added (`react-foundation`/
  `react-native-foundation` now correctly report as `react`/`react-native`
  rather than disappearing or double-counting against a real non-baseline
  entry).
- **Guess** (`src/deps/guess.ts`, new — the prototype had no guess stage):
  evidence-scored candidates for unmatched modules — curated
  `NativeModules`/`TurboModuleRegistry` name map (`src/deps/native-modules.ts`,
  version-independent, survives library-version drift that defeats hash
  matching), known third-party SDK URL/API hosts, APK-side hints
  (`src/deps/apk.ts`: manifest permissions/`.so` names/asset files, plus a
  minimal `aapt`-or-heuristic-AXML-scan fallback), dependency-edge
  propagation (tightened mid-task after it over-attributed >5000 of
  Discord's own modules to a baseline package off a 1-in-7 coincidence —
  now requires ≥2 identified deps or ≥50% agreement), and an npm registry
  search fallback (`fetch()`, no dependency) gated on `--offline`. Every
  string-keyed lookup table here is a real `Map`, not a plain object
  literal — a bundle's own strings are untrusted input, and
  `NATIVE_MODULE_TO_PACKAGE["hasOwnProperty"]` on a plain object returns
  `Object.prototype.hasOwnProperty`, not `undefined` (regression test in
  `tests/gate/deps/guess.test.ts`).
- **Confirm** (`src/deps/confirm.ts`): `npm pack` (never `npm install`, so a
  candidate's own scripts never run) + scratch Metro bundle + matching
  `tools/hermesc/v<N>` + fingerprint + match, writing a successful
  signature into the project-local DB and user cache; failures are recorded
  (not retried) in a small JSON log. Implemented and typechecked; not
  exercised end-to-end in this task's own seed run (see docs/DEPS.md's
  "Confirm stage" note — each candidate needs a from-scratch RN scaffold,
  and the seed run prioritised breadth over depth within its time budget).
- **Report** (`src/deps/report.ts`): human table + `--json`, `<out>/package.json`
  emission when confident, and `DepsReport.moduleOwnership` — the
  module-id-to-package map the M6 emitter needs (D19) to drop a recognised
  module from `<out>/src/`, exported from `src/index.ts` alongside the rest
  of the public `deps` surface (`runDeps`, `buildInventory`, `matchInventory`,
  their result types).
- **Seed run** (docs/DEPS.md has the full table): `rn-template-0.72` (2
  confirmed, 99.3% attributed), fresh-fetched `react-navigation-example-0.85.3`
  (all 9 real dependencies confirmed High, 61.9% attributed), and the local
  corpus (`~/hbc2js-local-corpus`, never committed) — Bloomberg/Xbox (9-10
  confirmed, 36-51% attributed), and **Discord/Shopify**, previously
  documented at <1% attribution and 2 identified packages
  (docs/PACKAGE-SIGNATURES.md §5.6): now 4 confirmed + 13-15 real
  native-module-evidence guesses each (17-19 total dependencies identified),
  though module-count attribution is still ~1% since most of both apps'
  bytecode is either first-party or a library vintage too far from the
  starter DB's pinned versions to hash-match — the honest state is "many
  more dependencies identified, attribution % not yet fixed", not "solved".
  Teams (ships several `hermes.android.bundle` micro-frontends at
  non-standard paths) and Pinterest (no RN bundle in the APK at all) are
  correctly reported as such rather than silently skipped.
- **`tools/pkgsig`**: the prototype's `.mjs` scripts and `lib/` are deleted
  (logic promoted into `src/deps/**`, see the table in
  `tools/pkgsig/README.md`); `tools/pkgsig/db/` (the shared signature-DB
  starter set, ~16 MB) is unchanged and is now also listed in
  `package.json`'s `files` so it ships alongside `dist/` in the npm package
  (`private: true` still blocks actually publishing — T10 owns the rest of
  release packaging).
- **Tests**: `tests/gate/deps/{inventory,db,match,guess,apk}.test.ts` (37
  tests) + `tests/gate/cli/deps.test.ts` (6, CLI end-to-end) + `tests/sweep/deps/corpus.test.ts`
  (the seed-run corpus, INCONCLUSIVE-skip when absent). `npm test`: 801/801
  pass (0 fail) after this task's changes, including the two `54-try-catch-
  finally-shared-range` failures a concurrent M4-review-lane commit fixed
  mid-task (not this task's own fix).

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
- Local proprietary corpus (D16 C5, `~/hbc2js-local-corpus/apks/`, never in repo): 26 APKs, 22 with Hermes bytecode. HBC 99: Meta Horizon. HBC 98: Discord, Shopify, Klarna (1,108 bundles), Brex, Uniswap, Bluesky. HBC 96: Xbox, Bloomberg, Teams (3), Tesla, Wix (30), PlayStation, Shop, Expo Go, Phantom, Cameo, Shopify Inbox, MetaMask, Rainbow, Coinbase Wallet, Office (5). Plain JS only: Facebook (18 bundles — D18 case). Native, no bundle: Pinterest, Flipkart, Adidas. No HBC 94 in the wild.
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
