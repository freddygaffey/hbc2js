# Task board

Claim a task by editing this file: put your handle and date in the **Claimed** column in a commit *before* starting, so others see it. Tasks marked *in-flight (overseer)* are being done by the project's own agents — do not take them. Each task is independent of the others and of in-flight work.

| ID | Task | Skills | Claimed |
|---|---|---|---|
| T1 | Harvest Hermes's own MIT `test/hermes/*.js` lit tests into `tests/sweep/hermes-lit/` with a script that converts `// CHECK:` comments into `expected.txt` (see docs/TEST-CORPUS.md §1b, D13/D16). Verify each runs under Node with a `print` shim. | scripting | |
| T2 | Same for a curated test262 subset (BSD): pick ~200 tests on control flow, generators, try/finally, closures; write the harvester + licence file. | scripting | |
| T3 | Lowering catalogue, empirical (see docs/specs/07-pass-ladder.md for the required format) | reading bytecode | **done** (Claude Sonnet 5, 2026-08-30) — `docs/LOWERING-CATALOGUE.md` + 24 files under `docs/lowering/`, all spec 07 §6 first-ten idioms plus D14/generators/classes/obfuscation. Remaining gaps, each marked ⛔/⚠️ in the catalogue: `StringSwitchImm` and logical assignment have no fixture (ad hoc probes only, per spec 07 §12 O-3 style); the v≥97 generator/async resume-call ABI's exact action/status integer codes are unpinned (shape only); v99's async driver builtin/protocol wasn't traced; class static members and getters/setters weren't traced to bytecode. A pass must not be written against any ⛔ row per spec 07 §4. |
| T4 | GitHub Actions CI skeleton per `docs/specs/00-project-skeleton.md` §CI: macOS+Linux matrix, runs `tools/get-hermesc.sh all` cached, `node --test`, plus a licence-guard job that fails if any file contains hermes-dec code signatures. | CI | |
| T5 | Linux arm64 `hermesc`: extend `tools/build-hermes-vm.sh` (once merged) or write `tools/build-hermesc-linux-arm64.sh`; document in TOOLCHAIN.md. | C++ build | |
| T6 | Repo `README.md` for humans: what/why/status/how to run selftest, linking docs. | writing | |
| T7 | Property-based fuzz inputs for `tools/equiv` exports: extend the fuzzer's value generators (typed arrays, sparse arrays, Symbols, Proxies) and measure mutation-kill-rate change. | JS testing | |
| T8 | Feasibility study for D17 (npm package recognition): bundle react@18.2 + lodash via Metro, compile with hermesc v94, and measure how many functions match byte-for-byte (after normalisation) against the same package inside `tests/fixtures/bundles/rn-template-0.72`. Report in docs/PACKAGE-SIGNATURES.md. No decompiler code needed — use `hermesc -dump-bytecode` + a script. | scripting, analysis | |
| T9 | Irreducible-CFG stress fixtures (D13a): hand-written JS whose CFG is genuinely irreducible after hermesc (runtime-derived state machines, cross-jumping loops), plus fixtures for `StringSwitchImm` (v98+) and logical assignment, which the catalogue lacks. Verify with `-dump-bytecode`. | JS, bytecode | |
| — | Parser / disassembler implementation (specs 01, 02) | *in-flight (overseer)* | |
| — | Fixture variants, real-app bundles, Hermes VM build | *in-flight (overseer)* | |

Done tasks move to the bottom with the commit SHA.
