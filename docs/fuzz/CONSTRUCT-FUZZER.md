# Construct-level fuzzer — usage

Implements `docs/specs/09-fuzzing.md` §1 and §7 steps 1–2 (component A only;
component B, the app-generation fuzzer, is not implemented here). Read the
spec first — this file is usage notes, not a re-statement of the design.

## Layout

- `src/fuzzgen/grammar.ts` — `GRAMMAR_VERSION`, banned-token allowlist.
- `src/fuzzgen/generate.ts` — seeded generator, `generate(seed, grammarVersion)`,
  50/50 grammar-mode/mutation-mode per seed (§1.2).
- `src/fuzzgen/mutate.ts` — mutation mode: mutates a construct fixture's
  `source.js`, `node --check`-verified with a pristine-fixture fallback.
- `src/fuzzgen/seedRange.ts` — §1.5.iv work/eval seed-range discipline
  (`workRange`, `evalRange`, `hasWorkEvalOverlap`), enforced programmatically:
  the driver's `--eval` flag is the only way to reach the evaluation range.
- `src/fuzzgen/signature.ts` — divergence dedup key (§1.4 step 1).
- `src/fuzzgen/minimise.ts` — ddmin-style reducer, `minimise(program, reproduces)`
  (§1.4 step 2). **Wired as a library and unit-tested (T3) but the driver does
  not yet call it live** — see "Deferred" below.
- `tools/fuzz/construct-fuzz.mjs` — the driver (§1.1, §7 step 2).

## Running

```
node tools/fuzz/construct-fuzz.mjs --versions 84,94,96,98,99 --count 500 \
     --seed-base 1000 --out reports/fuzz/construct-<date>-<runid>.json
```

- `--versions` — comma-separated HBC versions. 84/94/96/99 get the full
  traced ladder (minus `roundtrip`, see "Oracle set" below); 98 gets
  syntax+roundtrip only, reported with `mode: "roundtrip-only"` (§1.3).
- `--count` — programs per version.
- `--seed-base` — campaign seed base `S`. Work range is `[S, S+80000)`;
  pass `--eval` to run the disjoint evaluation range `[S+900000, S+902000)`
  instead (§1.5.iv) — never the default, so a tuning run cannot touch it by
  accident.
- `--out` — report path. Reports are gitignored (`reports/`, §4.2's
  committed-record rule); nothing under `reports/` is ever committed. The
  committed record is a scoreboard row (`tools/metrics/`, being built
  concurrently), not a snapshot of this directory.
- Requires `tools/get-hermesc.sh <version>` to have been run for every
  version passed; a missing hermesc reports `ERROR` for that version's cells
  rather than crashing the run.

## Oracle set (PUSHBACK P-12, `docs/PUSHBACK.md`)

Traced versions run `syntax+trace+fuzz`, **not** the spec's literal
`syntax+trace+fuzz+roundtrip` four-oracle set. `roundtrip` compares function
*count* between the original bytecode and a recompile of the decompiled
candidate, and hbc2js's decompiled output always injects its own runtime
helpers (`__hbc_iterBegin` et al.) as extra top-level functions the original
never had — `src/harness/tiers.ts`'s `defaultOraclesForTier` already excludes
`roundtrip` for a real decompiler on the gate tier for exactly this reason.
Composing the literal four-oracle ladder here reported 3/3 DIVERGENT (all one
`functionCountMismatch` signature) on an early smoke run of otherwise-correct
programs. See `docs/PUSHBACK.md` row P-12 for the full evidence and the two
resolution options put to Fred/a checker. v98's roundtrip-only lane is
unaffected — the spec already marks that cell unreliable-by-design.

## Minimisation — landing a find

1. A DIVERGENT/ERROR verdict's raw (unminimised) program is written to
   `reports/fuzz/finds/v<version>-seed<seed>.js` (capped at 200 files/run).
2. Compute (or read, if the driver already printed it) the divergence
   signature (`src/fuzzgen/signature.ts`); check `docs/BUGS.md` for an
   existing row with a matching signature before treating it as novel.
3. Manually minimise with `src/fuzzgen/minimise.ts`'s `minimise(program,
   reproduces)`, where `reproduces` re-runs the program through
   hermesc→decompile→`runOracleLadder` for the failing version and checks the
   signature still matches. (This live-reproduces loop is not yet wired into
   the driver itself — see "Deferred".)
4. Land per repo hard rules (§1.4 step 3): a new
   `tests/fixtures/constructs/NN-fuzz-<slug>/` fixture (source + `build.sh`
   output for all five versions) **and** a `docs/BUGS.md` row citing the
   campaign/seed, or a `docs/BUGS.md` row alone if it is a toolchain issue
   rather than a decompiler bug. Never fixed silently, never left
   undocumented.

## Deferred (follow-up, not in this task's scope)

- **Live auto-minimiser in the driver.** `runOne`'s DIVERGENT/ERROR branch
  currently writes the raw program to `reports/fuzz/finds/` and stops; it does
  not call `minimise()` with a live `reproduces` callback (that would
  multiply each find's cost by hermesc+decompile+ladder per ddmin candidate).
  `src/fuzzgen/minimise.ts` and its `reproduces: (program: string) => boolean`
  contract are ready for a follow-up to wire this in.
- **Component B (app-generation fuzzer, spec §2)** and **held-out set
  (§3, §7 step 3)** — out of this task's scope per the launch brief and the
  reviewer's approval (§7 steps 1–2 only).
- Nightly/steady-state scheduling and the metrics-scoreboard consumer
  (§4.2) — not built by this task; the report schema (`fuzz-matrix/1`) is
  the agreed handoff surface.

## Known real find from the smoke run

`docs/BUGS.md` (2026-09-02 row, cluster `passes`): the differential-fuzz
oracle, applied to `tests/fixtures/constructs/59-jsx-runtime-calls/source.js`
via mutation mode, found that the decompiled candidate's parameter names
diverge from source names on error paths the fixture's own top-level code
never exercises (`screen`/`html`/`cleanup` — TypeError message text embeds
`r13`/`arr`/`r3` instead of `items`/`log`/`strings`). A real, if narrow,
naming-recovery gap surfaced by fuzzing with a wider argument space than any
hand-written fixture's own top-level calls provide — exactly what component A
is for. Not fixed here per this task's scope; filed, not ignored.
