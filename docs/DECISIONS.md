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
