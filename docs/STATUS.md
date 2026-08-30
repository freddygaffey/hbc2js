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
Nothing yet — only spec and two fixture pairs exist.

## Known gaps
- No Hermes compiler installed on dev machine.
- Only v94/v99 fixtures; spec mentions v84 with no fixture.
