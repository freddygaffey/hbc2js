# hbc2js

Decompile React Native **Hermes bytecode** (`.hbc` / `index.android.bundle`) back into **runnable JavaScript**, segregate it into a readable `src/` project, and build a queryable, versioned analysis database over it — with results checked against the real Hermes VM.

Existing Hermes tools stop at disassembly or pseudo-code. hbc2js produces JavaScript that executes and is checked to behave identically to the original bytecode (execution traces against the real Hermes VM, differential-testing generators, recompile-with-`hermesc` round-trips), then goes further: it strips libraries out to `node_modules/`, recovers named screens and navigators into a `src/` tree, identifies npm dependencies by bytecode signature, and exposes the whole decompile as a queryable project database for analysis tooling.

## Status

Working: bytecode → runnable, VM-checked JavaScript; library/app segregation with recovered screen and navigator names; npm dependency identification; a SQLite signature database; and a per-project analysis database. Readability passes and the analysis environment are actively expanding. See [`docs/STATUS.md`](docs/STATUS.md) for live numbers.

| Component | State |
|---|---|
| Parser — HBC 84, 94, 96, 98, 99 | ✅ verified on every fixture and on 50 MB production bundles |
| Disassembler (`hbc2js disasm`) | ✅ 100% match against `hermesc -dump-bytecode` |
| Baseline decompiler (`hbc2js <in.hbc> <out.js>`) | ✅ every fixture → runnable JS, checked vs the Hermes VM; proven on-device on a real RN app |
| Equivalence harness | ✅ mutation-tested; Hermes VM ground truth for the traceable versions, compiler and VM matched per version |
| Fuzzing / ground truth | ✅ construct-level generator (random JS → `hermesc` → decompile → trace-compare) + app-generation fuzzer (builds varied RN apps to `(bundle, source-map, source)` triples) |
| Readability passes (ladder) | 🚧 17 of ~30 rungs live — loops, expressions, calls, globals, function + variable naming, register-splitting, destructure/spread, optional-chaining, JSX; deobfuscation rungs deferred |
| Segregation (`hbc2js segregate`) | ✅ splits a bundle into `node_modules/<pkg>/` vs `src/`, recovering real screen + navigator names from route config where present |
| Dependency identification (`hbc2js deps`) | ✅ identifies npm packages by bytecode fingerprint (evidence-directed) → `package.json` |
| Signature database | ✅ SQLite, tiered-exportable (migrated from a 71k-file JSON store) |
| Project database (`hbc2js init` → `.hbcproj`) | 🚧 versioned SQLite: artifact index (call graph, string/global xrefs, native surface, module graph) + append-only annotations; JSON is a generated view |
| Analysis tooling | 🚧 secrets/string indexer, OSV/GHSA dependency-CVE matching, version diff, and an MCP interface — building |

## Quick start

```sh
git clone https://github.com/freddygaffey/hbc2js && cd hbc2js
npm install                      # zero runtime deps; dev-only TypeScript
tools/get-hermesc.sh all         # fetch Hermes compilers (macOS / Linux x86_64)
npm test                         # gate tier
node src/cli.ts disasm tests/fixtures/hermes-dec-sample/v94.hbc
```

Requires Node ≥ 22 (uses the built-in `node:sqlite`). Python 3 is needed only for the optional hermes-dec oracle. `tools/build-hermes-vm.sh 94|99` builds Hermes VMs from source (cmake) for ground-truth traces.

## How it works

```
.hbc ─► parse ─► disassemble ─► CFG ─► structure ─► emit ─► readability passes ─► .js
                                       (Ramsey ICFP'22)
     ─► segregate ──► node_modules/<pkg>/  +  src/ (named screens, navigators)
     ─► index + annotate ──► project.hbcproj (queryable, versioned; JSON is a view)

  harness: trace vs Hermes VM · differential-testing generators · recompile round-trip
```

Design principles, each recorded with its reasoning in [`docs/DECISIONS.md`](docs/DECISIONS.md):

- **Correct first, readable second.** The baseline emits (ugly) JS whose equivalence is checked by trace against the Hermes VM on the fixture corpus — not yet proven on whole real bundles, see `docs/CONSOLIDATION.md` §A; readability comes from small, individually verified rewrite passes.
- **The bytecode is the ground truth, not the source.** Hermes deviates from spec in places (per-iteration `let`, TDZ, `arguments`); we reproduce what the bytecode does.
- **Never trust the version field.** Layouts and opcode tables are detected by probing, because Hermes has shipped incompatible formats under the same version number.
- **Truth before convenience.** A finding is a candidate until its evidence resolves; the analysis database is storage and JSON is a generated view over it; an independent checker re-derives every index edge rather than trusting the writer.
- **Every claim is tested against real bytes** — fixtures compiled with pinned `hermesc` builds, oracles from Meta's own tooling.

## Documentation

Start with [`docs/RESEARCH-SUMMARY.md`](docs/RESEARCH-SUMMARY.md). Then:

- [`docs/HBC-FORMAT.md`](docs/HBC-FORMAT.md) — the bytecode format, byte-verified
- [`docs/LOWERING-CATALOGUE.md`](docs/LOWERING-CATALOGUE.md) — what each JS construct compiles to
- [`docs/TESTING.md`](docs/TESTING.md) — test tiers, trace format, verdict semantics
- [`docs/TOOLCHAIN.md`](docs/TOOLCHAIN.md) — compilers and VMs per bytecode version
- [`docs/specs/08-segregation.md`](docs/specs/08-segregation.md) — library/app split and screen/navigator naming
- [`docs/specs/09-fuzzing.md`](docs/specs/09-fuzzing.md) — the fuzzing and ground-truth programme
- [`docs/specs/15-sigdb-schema.md`](docs/specs/15-sigdb-schema.md), [`16-project-db.md`](docs/specs/16-project-db.md), [`17-mcp-harness.md`](docs/specs/17-mcp-harness.md) — the databases and analysis interface
- [`docs/specs/`](docs/specs/) — all component specifications and their reviews

## Contributing

Humans and AI agents welcome — this project is largely built by AI agents working from written specs, with reviews before and after every implementation. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and a prompt to hand your agent, and [`docs/TASKS.md`](docs/TASKS.md) for claimable work.

## Licence and provenance

MIT. Opcode tables are generated from the MIT-licensed Hermes sources (pinned commits under `third_party/`). No code is derived from hermes-dec (AGPL); it is used only as an external oracle. Test fixtures list their licences alongside them; proprietary app bundles are never committed.

## Legal note

Use this tool only on software you are authorised to analyse. Decompilation may be restricted by licence agreements or law in your jurisdiction.
