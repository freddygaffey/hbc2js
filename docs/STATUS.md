# Project status

Last updated: 2026-08-30

## Milestones
- [x] M0 Research: toolchain (`hermesc` locally), prior-art survey, test corpus candidates
- [ ] M1 Parser: header, string table, function table, bytecode — v94 & v99 fixtures
- [ ] M2 Disassembler + diff test against hermes-dec output
- [ ] M3 Test harness: sandboxed trace runner (D2) + recompile round-trip (D3)
- [ ] M4 CFG + structurer + emitter → v94/v99 fixtures pass trace equivalence
- [ ] M5 CLI, real-world bundle survives, docs complete
- [ ] M6 Open-source RN app corpus passes round-trip

## Currently working
- `hermesc` toolchain: `tools/get-hermesc.sh` fetches HBC v84/v94/v99 compilers
  (npm-sourced, not committed) for macOS + Linux x86_64. v94 recompiles
  `tests/fixtures/v94.js` byte-identical to `tests/fixtures/v94.hbc`. v99 does
  not byte-match (different Hermes commit, same wire format — see
  `docs/TOOLCHAIN.md`). `hermes-dec` 0.1.7 (pip) confirmed working as the
  behaviour-oracle disassembler/decompiler. Details: `docs/TOOLCHAIN.md`.
- Prior art + HBC format research done: `docs/PRIOR-ART.md` (survey of 12 tools,
  structuring-literature recommendation, risk register) and `docs/HBC-FORMAT.md`
  (our own format write-up, verified byte-for-byte against the v84/v94/v99/v99-public
  fixtures — header, section offsets, both function-header layouts, exception tables,
  debug offsets, opcode numbering).
- Otherwise: no parser/CLI code yet.

## Known gaps
- No Linux arm64 `hermesc` build published anywhere found; only Linux x86_64.
- No `.hbc` fixture yet exercises literal buffers / object shape table / BigInt table /
  `SwitchImm` jump tables, nor an overflowed string entry, nor an optimised (`-O`) build.
  `tests/fixtures/constructs/` covers the language surface but is not compiled yet —
  see `docs/PRIOR-ART.md` §7.4. Compile it before M4.
- `docs/TOOLCHAIN.md` still refers to the pre-move fixture paths
  (`tests/fixtures/v94.hbc` etc.); fixtures now live in
  `tests/fixtures/hermes-dec-sample/`.
- Proposed decision **D7** (Ramsey-style total structurer replacing the
  `for(;;) switch(ip)` fallback of D6) is written up in `docs/PRIOR-ART.md` §7.2 but not
  yet ratified in `docs/DECISIONS.md`.
