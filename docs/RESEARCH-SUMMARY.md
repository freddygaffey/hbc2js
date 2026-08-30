# Research summary and feasibility assessment

Overseer-maintained digest of the Phase 0 research. Detailed findings live in the linked docs; this file is the place to start if you have no other context. Update it whenever a research track reports.

Last updated: 2026-08-30

## Verdict so far
Feasible. The two early-kill risks (no compiler; no legal test corpus) are cleared. The remaining hard part is the structurer (CFG → structured JS, esp. generators/async and try/finally), which is where every prior tool stopped. Two reasons to expect success anyway: Hermes bytecode comes from one compiler with predictable lowering patterns, and D6's `for(;;) switch(ip)` fallback guarantees *correct* output in the worst case — the open question is readability, not correctness.

## Track A — Toolchain (`docs/TOOLCHAIN.md`)
- `tools/get-hermesc.sh [84|94|99|all]` fetches prebuilt `hermesc` via `npm pack`; macOS universal + Linux x86_64. No binaries committed.
- HBC 84 ← `hermes-engine-cli@0.8.1` (RN 0.64–0.69); 94 ← `react-native@0.72.17` bundled `sdks/hermesc`; 99 ← `hermes-compiler@260318099.x`. Versions 74–98 also mapped. RN ≥0.83 uses the separate `hermes-compiler` npm package.
- `tests/fixtures` v94 recompiles **byte-identical** (compile with a relative filename; the name is embedded). The v99 fixture came from a non-public Hermes commit (different builtin table, extra `Unreachable`); not reproducible, harmless.
- hermes-dec 0.1.7 (`hbc-disassembler`, `hbc-decompiler`, `hbc-file-parser`) works as an oracle, including on v99.
- Gap: no public Linux arm64 `hermesc`. Would need a source build for ARM Linux CI.

## Track C — Test corpus (`docs/TEST-CORPUS.md`)
- Tier 1 (execution-trace equivalence, D2): 51 single-construct programs to author; Hermes's own MIT `test/hermes/*.js` lit tests (expected output in CHECK comments — highest value); test262 (BSD), quickjs-ng tests (MIT); 5 pure-JS MIT libraries (lodash, date-fns, marked, validator, qs).
- Tier 2 (recompile round-trip, D3): 9 verified permissively-licensed RN/Expo apps. Top picks: bare `npx react-native init` template (trivial, reproducible), Expensify/App (MIT, large, satisfies the ~12 MB requirement), react-navigation example app (mid-size). Rejected on licence: MetaMask mobile (proprietary), Rainbow (GPL).
- Bundle sizes are estimates until measured.

## Track B — Prior art and HBC format (`docs/PRIOR-ART.md`, `docs/HBC-FORMAT.md`)
Pending (Opus agent running at time of writing). Fill in: reusable components, structuring strategy recommendation, top risks.

## Why the recompile round-trip matters
Real RN bundles cannot run in Node. Because `hermesc` output is reproducible, we can test at app scale by decompile → recompile → disassemble both → normalised diff, with zero execution. Execution-trace tests are reserved for pure-JS fixtures.
