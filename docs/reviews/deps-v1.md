# Review: `hbc2js deps` v1 (src/deps @ 1b679a3) — medium, adversarial

Reviewer: Claude Fable 5, 2026-08-30. Scope: `src/deps/**`, `tests/gate/deps/**`,
the D17/D17a/D17b/D17d decisions. Method: re-ran the tool on the committed
rn-template-0.72 release and `-g` fixtures, diffed the two builds' normalised
function texts, then built the D17d ground-truth suite and measured.

## Findings

**F1 — the guess stage invented six dependencies on a bundle that has none.**
`report.ts` promoted every *medium* and *low* DB score into `guessedDeps`. A
"low" score is *any* fuzzy hit: the fuzzy tier is the bare mnemonic sequence,
and trivial functions (`return this.x`, `_interopRequireDefault`-shaped
helpers) share mnemonic sequences across every package in the DB — so every
hbc94 package in the DB (axios, lodash, moment, zustand, ...) came out as a
0.30 guess. `@react-navigation/stack` reached *medium* off one module-exact
hit: with the require-call-site index masked to `dep#`, a bare re-export
factory (`module.exports = require(dep#)`) hashes identically in every
package, so one module of RN "belonged" to stack. Not DB-neighbour leakage
and not dependency inference — a tiering rule that treats collision-prone
evidence as a positive. The `guess.ts` evidence clues themselves were sound;
the aggregation in `report.ts` had no notion of independent corroboration.

**F2 — `-g` builds hashed nothing.** Diffing release vs debug normalised
texts: 0 of 4199 functions identical. Cause: `hermesc -g` inserts an
`AsyncBreakCheck` at every function entry and loop back-edge (4000+ of
them), which the normaliser kept as an ordinary instruction; every fuzzy,
exact and instruction-count view shifted. Eliding it (label carried to the
next kept instruction) brings 3223/4199 to identical text. The residue is
register allocation: `-g` allocates registers differently, and the exact
tier names registers by first use, so ~23% of functions — biased towards
the large module factories — still differ. Function *ordering* is unchanged.

**F3 — `--json | pipe` truncated at 64 KB.** `main()` called `process.exit`
in the deps `.then`; pipe writes are asynchronous in Node. Same pattern in
`equiv`/`gate`/`sweep` (left alone — outside this task's files, noted here).

**F4 — `reactNativeVersion` was null only on the `-g` fixture** (consequence
of F2); the release bundle detected 0.72.17 throughout.

**F5 — bare npm-search hits (0.15 each) were reportable** when nothing else
fired, producing `aliceblue`/`add`/`assert` on the `-g` bundle. Consequence
of F1's missing corroboration rule, not a separate defect.

**F6 (minor, from docs/BUGS.md)** `dscan.ts` called `readLiterals` without
the bytecode version — wrong tag decoding at v≥97. One-line fix applied.

## Architecture

Inventory → match → guess → confirm with a three-layer DB is the right
shape, and the inventory (structural `__d()` recovery), the normaliser's
dependency-map masking, and the DB layering are sound and stay. Two design
gaps: (a) the DB fingerprints a package *with* its transitive dependencies
minus three baselines, so `@babel/runtime`, `invariant`, `prop-types` etc.
are structurally attributed to `react-native` — fine for "what should
`package.json` list", wrong for per-module ownership (the truth suite now
measures both); (b) the exact hash's register naming makes the exact tier
build-flag-sensitive — a register-insensitive structural hash (all operands
kept, registers masked) would be the durable fix but changes the DB format,
which `tools/pkgsig/bulk` owns.

## Verdicts

| Component | Verdict | Action taken |
|---|---|---|
| inventory / dscan | MERGE | `readLiterals` version arg (F6) |
| sig-normalise / fingerprint | REFACTOR (done) | debug-only instructions elided (F2) |
| match | REFACTOR (done) | fuzzy+string-set factory fallback with size and ambiguity guards, `ownerBasis` recorded |
| guess | MERGE | `package-name-string` clue added as a second, network-free evidence kind |
| report (guess aggregation) | REFACTOR (done) | precision rules: low tier is not evidence, ≥2 independent kinds, 0.5 floor, npm-search never alone, DB-negative veto; `suppressedGuesses` in `--json` |
| confirm | MERGE (unexercised) | still not run end-to-end — unchanged |
| CLI | MERGE | `process.exitCode` (F3) |

Numbers before/after: `docs/DEPS.md` "Ground truth (D17d)".
