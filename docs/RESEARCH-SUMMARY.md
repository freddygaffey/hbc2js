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
- **The field moved in 2026.** Two permissively licensed Rust decompilers now emit structured JS: `SymbioticSec/hermes-decomp` (MIT, HBC 40–99, very active) and `droidsaw/droidsaw-hermes` (BSD-3, SSA + region structuring + a `hermesc` recompile ratchet). `kroo/hermes-dec-rs` (MIT/Apache) is the closest in intent. hermes-dec (AGPL) remains disassembly-grade only: on our fixtures it recovers **zero** loops, `try`s and `yield`s, emits pseudo-instructions (`SaveGenerator(...)`, `CatchBlockStart(...)`), and both outputs throw on the first line that touches `window`. SPEC's "nobody produces runnable JS" is now true only in the narrow sense that **nobody verifies** it — so D2 (execution-trace equivalence) + D3 are the differentiator, not "structured output".
- **Format is fully written up** in `docs/HBC-FORMAT.md`, derived from MIT Hermes and verified byte-for-byte against v84/v94/v99/v99-public. Five layout-equivalence classes; the file header is always 128 bytes; v84–v96 share one function-header layout.
- **Two format hazards.** The version field does not determine the layout: v98 has two incompatible header layouts (the v99-shaped header landed before the version bump) and v99 has two incompatible opcode tables (`NewTypedObjectWithBuffer` inserted at index 4 without a bump). The parser must *probe*, not switch on `version`.
- **Static Hermes (v97+) removes generator/async opcodes entirely** — `StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`/`Create{Generator,Async}Closure` are gone; the compiler lowers generators to an explicit state machine and marks the function via a 2-bit `kind` field in the header flags. v94 and v99 therefore need different generator front-ends. Recommended floor for v99: emit the state machine as a plain function plus a small `__hbc_makeGenerator` runtime shim (provably correct), and defer `yield` recovery.
- **Structuring recommendation (proposed D7):** replace SPEC's "irreducible → `for(;;) switch(ip)`" with Ramsey's ICFP'22 recursive CFG→structured translation as the *universal* core — it is total, needs no irreducibility test, and emits labelled blocks + `while(true)` + multi-level `break`. Layer readability rewrites (`while(c)`, `for`, `switch`, early-return flattening) on top as testable AST passes; DREAM-style condition-aware structuring only if needed. Exception regions are carved from the handler table *before* structuring; exception edges never enter the dominator computation.
- **Top risks:** silent version/layout misdecode; v99 generators; environment-slot resolution failures (hermes-dec's exact bug — dangling `_closure1_slot1`); `finally` not existing in the format (duplicated blocks only); and untested format paths — literal buffers, shape table, BigInt and switch jump tables are all `0` in every current `.hbc` fixture.

## Why the recompile round-trip matters
Real RN bundles cannot run in Node. Because `hermesc` output is reproducible, we can test at app scale by decompile → recompile → disassemble both → normalised diff, with zero execution. Execution-trace tests are reserved for pure-JS fixtures.
