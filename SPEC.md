# hbc2js — Hermes Bytecode → Runnable JavaScript

## Goal

Decompile React Native **Hermes bytecode** (`.bundle` / `.hbc` files) into **semantically equivalent, runnable JavaScript** — not pseudo-code, not disassembly. The output must execute in a standard JS engine and produce the same observable behaviour as the original source.

## Motivation

Existing tools stop short:

- **hermes-dec** (P1sec, AGPL): parses, disassembles, and emits *pseudo-code*. Its own README states the output "is not valid JavaScript yet as it does not retranscribe loop/conditional structures."
- **hbc-toolbox / objdump**: disassembly only.

Nobody produces runnable JS. This project closes that gap.

## Scope

### In scope

1. **HBC parsing** — header, string table, function tables, bytecode functions. Target Hermes versions: 84, 94, 99+ (fixtures provided).
2. **Disassembler** — faithful instruction-level output (already largely solved by hermes-dec; can be used as reference).
3. **Structured decompiler** — the novel work:
   - Control-flow graph construction from jump targets
   - Structured recovery: `if/else`, `while`, `for`, `switch`, `try/catch/finally`
   - Function closure reconstruction (Hermes creates nested scopes via function-table indices)
   - String/symbol resolution
   - **Output: valid ES2022 JavaScript** that runs under Node / any modern engine
4. **Test suite** — round-trip verification:
   - For each fixture `tests/fixtures/vN.js` + `vN.hbc`:
     - Decompile `vN.hbc` → `out.js`
     - Execute `out.js` and capture behaviour (return values, console output, generator sequences)
     - Execute `vN.js` the same way
     - **Assert semantic equivalence** of observable behaviour
5. **CLI** — `hbc2js <input.hbc> [output.js]`

### Out of scope

- **Name recovery** — variable/function names are erased by Hermes; output uses generated names (`_fun0`, `r32`). Reconstructing original names is impossible and not attempted.
- **Native bridging** — the input is pure JS bytecode; React Native native-module calls are call sites like any other, no special handling.
- **Embedding into a web/RN runtime** — producing a runnable app bundle from a decompiled app is a downstream concern (stub-layer project), not this tool.

## Architecture sketch

```
.hbc file
   │
   ▼
Parser        ──  header, string table, function table, instruction stream
   │
   ▼
Disassembler  ──  linear instruction list with jump targets resolved
   │
   ▼
CFG builder   ──  basic blocks + edges from Jmp/JmpTrue/JmpFalse/switch/try
   │
   ▼
Structurer    ──  structural analysis (normal-form: if/while/seq; exceptions for irreducible flow → switch(ip) fallback)
   │
   ▼
Emitter       ──  ES sources: functions, closures, literals, string-table deref
   │
   ▼
.js file (runnable)
```

Design notes:

- **Fallback rule** — irreducible control flow falls back to the `for(;;) switch(ip)` pattern (guaranteed correct, ugly). Gradient of recovery: full structure where possible, switch-soup only where needed.
- **Reference implementation** — `hermes-dec` Python code is AGPL; do not copy code. Use it only as a behaviour oracle during development (compare disassembly outputs).
- **Language choice** — TBD by implementation agents. Node/TypeScript is natural (output is JS, test harness runs JS natively); Python is acceptable but the test runner then needs a JS subprocess.

## Test fixtures

Located in `tests/fixtures/`, sourced from the hermes-dec repo's own test corpus:

| Pair | Hermes version | Notes |
|---|---|---|
| `v94.hbc` / `v94.js` | 94 | async/await, generators, try/catch-nesting, BigInt |
| `v99.hbc` / `v99.js` | 99-202602 | same source compiled under newer spec |

**Adding fixtures:** any real-world RN app compiled with `hermesEnabled=true` contributes a bundle. Ground-truth pairs require the original source, so fixtures must come from open-source RN projects (or self-compiled samples).

## Definition of done

1. `hbc2js tests/fixtures/v94.hbc` emits syntactically valid JS (passes `node --check`).
2. Running the emitted JS produces behaviour equivalent to `v94.js` for all covered constructs (test/behaviour-test suite green).
3. Same for `v99`.
4. Handles a real-world ~12MB RN bundle without crashing (correctness on live bundles is validated via disassembly comparison, not execution).

## Non-goals for v1

- Perfect structured recovery (switch-fallback acceptable on irreducible CFGs)
- Perf-polished output (readability in decompiled dumps is secondary to correctness)
- Web UI (CLI only)
