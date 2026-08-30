# hbc2js

Decompile React Native **Hermes bytecode** (`.hbc` / `index.android.bundle`) back into **runnable JavaScript** — and prove the result is semantically equivalent.

Existing Hermes tools stop at disassembly or pseudo-code. hbc2js produces JavaScript that executes, and ships with a test harness that checks it behaves identically to the original bytecode: execution traces against the real Hermes VM, differential fuzzing, and recompile-with-`hermesc` round-trips.

## Status

Early, working, incomplete. See [`docs/STATUS.md`](docs/STATUS.md) for live numbers.

| Component | State |
|---|---|
| Parser — HBC 84, 94, 96, 98, 99 | ✅ verified on every fixture and on 50 MB production bundles |
| Disassembler (`hbc2js disasm`) | ✅ 100% match against `hermesc -dump-bytecode` and hermes-dec |
| Equivalence harness (`hbc2js gate` / `equiv`) | ✅ mutation-tested; Hermes VM ground truth for 4 of 5 versions |
| Test corpus | ✅ 53 construct programs × 5 versions, obfuscated variants, real RN apps |
| Baseline decompiler (correct, ugly) | 🚧 in progress |
| Readability passes | ⏳ next |
| npm package recognition, per-module project output | ⏳ planned |

## Quick start

```sh
git clone https://github.com/freddygaffey/hbc2js && cd hbc2js
npm install                      # zero runtime deps; dev-only TypeScript
tools/get-hermesc.sh all         # fetch Hermes compilers (macOS / Linux x86_64)
npm test                         # gate tier
node src/cli.ts disasm tests/fixtures/hermes-dec-sample/v94.hbc
```

Requires Node ≥ 22. Python 3 is needed only for the optional hermes-dec oracle. `tools/build-hermes-vm.sh 94|99` builds Hermes VMs from source (cmake) for ground-truth traces.

## How it works

```
.hbc ─► parser ─► disassembler ─► CFG ─► structurer ─► emitter ─► .js
                                          (Ramsey ICFP'22)      │
                     harness: trace vs Hermes VM · fuzz · recompile round-trip
```

Design principles, each recorded with its reasoning in [`docs/DECISIONS.md`](docs/DECISIONS.md):

- **Correct first, readable second.** The baseline emits provably equivalent (if ugly) JS; readability comes from small, individually verified rewrite passes.
- **The bytecode is the ground truth, not the source.** Hermes deviates from spec in places (per-iteration `let`, TDZ, `arguments`); we reproduce what the bytecode does.
- **Never trust the version field.** Layouts and opcode tables are detected by probing, because Hermes has shipped incompatible formats under the same version number.
- **Every claim is tested against real bytes** — fixtures compiled with pinned `hermesc` builds, oracles from Meta's own tooling.

## Documentation

Start with [`docs/RESEARCH-SUMMARY.md`](docs/RESEARCH-SUMMARY.md). Then:

- [`docs/HBC-FORMAT.md`](docs/HBC-FORMAT.md) — the bytecode format, byte-verified
- [`docs/LOWERING-CATALOGUE.md`](docs/LOWERING-CATALOGUE.md) — what each JS construct compiles to
- [`docs/TESTING.md`](docs/TESTING.md) — test tiers, trace format, verdict semantics
- [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md) — compilers and VMs per bytecode version
- [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) — other tools and what we learned from them
- [`docs/specs/`](docs/specs/) — component specifications and their adversarial reviews

## Contributing

Humans and AI agents welcome — this project is largely built by AI agents working from written specs, with reviews before and after every implementation. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and a prompt to hand your agent, and [`docs/TASKS.md`](docs/TASKS.md) for claimable work.

## Licence and provenance

MIT. Opcode tables are generated from the MIT-licensed Hermes sources (pinned commits under `third_party/`). No code is derived from hermes-dec (AGPL); it is used only as an external oracle. Test fixtures list their licences alongside them; proprietary app bundles are never committed.

## Legal note

Use this tool only on software you are authorised to analyse. Decompilation may be restricted by licence agreements or law in your jurisdiction.
