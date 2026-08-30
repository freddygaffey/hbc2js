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
