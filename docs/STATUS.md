# Project status

Last updated: 2026-08-30

## Milestones
- [x] M0 Research: toolchain (`hermesc` locally), prior-art survey, test corpus candidates
- [ ] M1 Parser: header, string table, function table, bytecode — v94 & v99 fixtures
- [ ] M2 Disassembler + diff test against hermes-dec output
- [ ] M3 Test harness: sandboxed trace runner (D2) + recompile round-trip (D3)
- [ ] M4 Baseline: CFG + Ramsey structurer + emitter (with D9 shim) → **every** fixture passes the equivalence gate, ugly output allowed (D11)
- [ ] M5 Pass ladder: one construct fixture per iteration as matcher/writer/checker pass (D12), catalogue row per pass; track `N/51 recovered` here
- [ ] M6 CLI + Tier 2 sweep (D13): RN template bundle and Expensify-scale bundle survive; recompile round-trip clean

## Currently working
- `hermesc` toolchain: `tools/get-hermesc.sh` fetches HBC v84/v94/v99 compilers
  (npm-sourced, not committed) for macOS + Linux x86_64. v94 recompiles
  `tests/fixtures/hermes-dec-sample/source.js` byte-identical to
  `tests/fixtures/hermes-dec-sample/v94.hbc`. v99 does not byte-match
  (different Hermes commit, same wire format — see `docs/TOOLCHAIN.md`).
  `hermes-dec` 0.1.7 (pip) confirmed working as the behaviour-oracle
  disassembler/decompiler. Details: `docs/TOOLCHAIN.md`.
- **Tier 1 fixture corpus built**: 51 hand-written single-construct fixtures
  under `tests/fixtures/constructs/<NN-topic>/{source.js,expected.txt,vNN.hbc,licence.txt}`
  (per `docs/TEST-CORPUS.md` §1a), plus the restructured `hermes-dec-sample/`
  (now also has a `v84.hbc` and a `v99-public.hbc`, alongside the two
  preserved historical `v94.hbc`/`v99.hbc` binaries). All 51 run correctly
  under Node 25 (`expected.txt` captured from that run); 138/153
  (fixture × hermesc-version) combinations compile — the 15 gaps are
  documented per-fixture in `versions.txt` and summarized in
  `tests/fixtures/README.md`'s compatibility table. A same-VM cross-check
  against the real `hermes` interpreter (bundled with the v84 package only)
  found 4 genuine Node-vs-Hermes-v84 runtime behavioural differences
  (`let`-in-for-loop closure capture, TDZ-vs-shadowing, and non-strict
  `arguments`/parameter aliasing) — see `tests/fixtures/README.md` for full
  detail; not fixture bugs, Hermes v84 diverges from spec/Node there.
  `tests/fixtures/build.sh` regenerates every `.hbc` idempotently.
- Prior art + HBC format research done: `docs/PRIOR-ART.md` (survey of 12 tools,
  structuring-literature recommendation, risk register) and `docs/HBC-FORMAT.md`
  (our own format write-up, verified byte-for-byte against the v84/v94/v99/v99-public
  fixtures — header, section offsets, both function-header layouts, exception tables,
  debug offsets, opcode numbering).
- Otherwise: no parser/CLI code yet.

## Known gaps
- No Linux arm64 `hermesc` build published anywhere found; only Linux x86_64.
- `tests/fixtures/constructs/` is now compiled (138/153 fixture×version
  combinations; see `tests/fixtures/README.md`), but no `.hbc` fixture yet
  specifically exercises literal buffers / object shape table / BigInt table /
  `SwitchImm` jump tables, nor an overflowed string entry, nor an optimised
  (`-O`) build — see `docs/PRIOR-ART.md` §7.4. A v84 fixture pair now exists
  (`tests/fixtures/hermes-dec-sample/v84.hbc`, plus v84.hbc for 43/51
  construct fixtures — 8 don't compile on v84, see that directory's README).
- `docs/TOOLCHAIN.md` still refers to the pre-move fixture paths
  (`tests/fixtures/v94.hbc` etc.); fixtures now live in
  `tests/fixtures/hermes-dec-sample/`.
- Proposed decision **D7** (Ramsey-style total structurer replacing the
  `for(;;) switch(ip)` fallback of D6) is written up in `docs/PRIOR-ART.md` §7.2 but not
  yet ratified in `docs/DECISIONS.md`.
