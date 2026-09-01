# 2026-09-01 — E2E tier 1: corpus round-trip ratchet — Fable, general-purpose type
Tokens 231k+ (paused waiting on the Service NSW passes-on run) · tool calls 144 · merged (3 commits) green.

Harness `tools/e2e/roundtrip-corpus.ts`: `--split` → per-module recompile with the matching hermesc → normalised-disassembly diff per FUNCTION → IDENTICAL/DIFFERENT/RECOMPILE-ERROR/DECOMPILE-STUB, bucketed by first differing opcode pair. Landed `--split` passes as an option (a489f29). Baseline `docs/e2e/roundtrip-baseline.json` + sweep ratchet test. 9 BUGS rows.

| bundle | HBC | mode | functions | IDENTICAL | wall |
|---|---|---|---|---|---|
| rn-template | v94 | passes-off | 4125 | 20.6% | 11 s |
| rn-template | v94 | passes-on | 4125 | **37.3%** | 16 s |
| react-navigation | v98 | passes-off | 14437 | 25.3% | 7 s |
| react-navigation | v98 | passes-on | 14437 | **29.5%** | 92 s |
| Service NSW | v96 | passes-off | 43302 | **15.6%** | 36 s |
| Service NSW | v96 | passes-on | (running) | | |

0 recompile errors, 0 stubs anywhere. Top buckets are opcode-pair diffs that look like register allocation / scheduling (`GetByVal(reg)`, `LoadParam(imm)`, `LoadConstUndefined/GetGlobalObject`, `CreateEnvironment/LoadParam`) — i.e. the normaliser is stricter than "same semantics"; some buckets are real (`TryGetById(string)`: different global name; `PutNewOwnById/PutById`: object-literal shape). QUEUE item 11 makes the diff allocation-insensitive so IDENTICAL measures semantics. Interpretation: this is a strict bytecode-level ratchet, NOT a behavioural pass rate; tier 2 (RN-web boot) is the behavioural test.
