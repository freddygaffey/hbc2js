# Task board

Claim a task by editing this file: put your handle and date in the **Claimed** column in a commit *before* starting, so others see it. Tasks marked *in-flight (overseer)* are being done by the project's own agents — do not take them. Each task is independent of the others and of in-flight work.

| ID | Task | Skills | Claimed |
|---|---|---|---|
| T1 | Harvest Hermes's own MIT `test/hermes/*.js` lit tests into `tests/sweep/hermes-lit/` with a script that converts `// CHECK:` comments into `expected.txt` (see docs/TEST-CORPUS.md §1b, D13/D16). Verify each runs under Node with a `print` shim. | scripting | |
| T2 | Same for a curated test262 subset (BSD): pick ~200 tests on control flow, generators, try/finally, closures; write the harvester + licence file. | scripting | |
| T3 | Lowering catalogue, empirical: for each `tests/fixtures/constructs/*`, disassemble v94 and v99 (`hermesc -dump-bytecode`) and document the idiom Hermes emits for the construct in `docs/LOWERING-CATALOGUE.md` (D12) — shape of blocks, jumps, env ops. No code. | reading bytecode | |
| T4 | GitHub Actions CI skeleton per `docs/specs/00-project-skeleton.md` §CI: macOS+Linux matrix, runs `tools/get-hermesc.sh all` cached, `node --test`, plus a licence-guard job that fails if any file contains hermes-dec code signatures. | CI | |
| T5 | Linux arm64 `hermesc`: extend `tools/build-hermes-vm.sh` (once merged) or write `tools/build-hermesc-linux-arm64.sh`; document in TOOLCHAIN.md. | C++ build | |
| T6 | Repo `README.md` for humans: what/why/status/how to run selftest, linking docs. | writing | |
| T7 | Property-based fuzz inputs for `tools/equiv` exports: extend the fuzzer's value generators (typed arrays, sparse arrays, Symbols, Proxies) and measure mutation-kill-rate change. | JS testing | |
| — | Parser / disassembler implementation (specs 01, 02) | *in-flight (overseer)* | |
| — | Fixture variants, real-app bundles, Hermes VM build | *in-flight (overseer)* | |

Done tasks move to the bottom with the commit SHA.
