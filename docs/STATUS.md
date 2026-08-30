# Project status

Last updated: 2026-08-30

## Milestones
- [ ] M0 Research: toolchain (`hermesc` locally), prior-art survey, test corpus candidates
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
- Otherwise: only spec and two fixture pairs exist; no parser/CLI code yet.

## Known gaps
- No Linux arm64 `hermesc` build published anywhere found; only Linux x86_64.
- v84 has a working compiler (`tools/get-hermesc.sh 84`) but still no v84 fixture pair.
- Prior-art survey and test-corpus candidate sourcing (rest of M0) not done by this pass.
