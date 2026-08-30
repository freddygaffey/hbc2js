# hbc2js in one page (read this; open other docs only when your task needs them)

**Goal.** Decompile React Native Hermes bytecode (`.hbc`) into runnable JavaScript and *prove* equivalence. Correct first (M4 baseline, done), readable second (M5 passes), then real apps: dependency extraction, per-module project output, multi-bundle APKs (M6).

**Pipeline.** `src/parse` (bytes → tables; probes layout, never trusts the version field) → `src/disasm` (instructions, labels, switch tables; 100% match vs `hermesc -dump-bytecode`) → `src/cfg` (blocks, exception regions carved from handler tables, generator classification, env/closure graph) → `src/structure` (Ramsey ICFP'22 structurer with inline isomorphism verifier) → `src/emit` (JS + four runtime helpers incl. `__hbc_makeGenerator`) → `src/passes` (D12 matcher/writer/checker rewrites; readability only). `src/harness` = equivalence checker (trace vs Hermes VM, fuzz, recompile round-trip; verdicts PASS/DIVERGENT/INCONCLUSIVE — INCONCLUSIVE is never PASS). `src/deps` = npm dependency extraction (fingerprint DB + evidence-scored guesses + npm confirm).

**Bytecode versions.** 84, 94, 96, 98 (two layouts/tables), 99 (two opcode tables). Compilers: `tools/get-hermesc.sh NN` → `tools/hermesc/vNN/hermesc`. VMs: prebuilt ≤89, source-built `tools/hermes-vm/v94|v99`, v96 from the RN tarball; none for 98. Production apps ship 96/98/99.

**Semantics rule (D14).** The bytecode under the Hermes VM is ground truth, not the source under Node: Hermes shares one `let` binding across loop iterations, TDZ varies by version, no sloppy `arguments` aliasing. Emit what the bytecode does.

**Fixtures.** `tests/fixtures/constructs/<NN-name>/{source.js,expected.txt,vNN.hbc,…}` (54 constructs × 5 versions, `.obf`/`.min` variants; `build.sh` regenerates), `hermes-dec-sample/`, `bundles/` (RN template committed; react-navigation and Expensify via `fetch.sh`), `local-corpus/` (proprietary APK bundles — NEVER in the repo, hashes only).

**Tests.** `npm test` = gate (~70 s; must stay green, currently 800+ tests, 492/492 fixture PASS through the real decompiler). `npm run test:all` adds sweep (~2 min). `HBC2JS_REQUIRE_ORACLES=1` turns oracle skips into failures.

**Hard rules.** No code from hermes-dec (AGPL) — oracle only. Every change ships tests + docs in the same commit; every bug fix ships a regression test (semantic bugs → a new construct fixture) or a `docs/BUGS.md` row. Stage files explicitly, never `git add -A` (other agents share the tree). Commit with trailer `Co-Authored-By: Claude <Model> <noreply@anthropic.com>`; never push, never open PRs, never `gh`. Append one line to `docs/AGENT-LOG.md`. macOS + Linux.

**Where to look when needed.** Format: `docs/HBC-FORMAT.md`. What each JS construct compiles to: `docs/LOWERING-CATALOGUE.md` + `docs/lowering/*.md`. Decisions D1–D19a: `docs/DECISIONS.md`. Specs per component: `docs/specs/0N-*.md` (each has a "Review responses" section). Testing: `docs/TESTING.md`. Deps: `docs/DEPS.md`. Toolchain: `docs/TOOLCHAIN.md`. Status/numbers: `docs/STATUS.md`. Open bugs: `docs/BUGS.md`.
