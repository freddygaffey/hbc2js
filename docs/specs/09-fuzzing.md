# Spec 09 — Fuzzing & ground-truth programme

**Milestone:** post-M5 hardening (runs alongside M6; construct fuzzer first)
**Status:** ready for review (decision-8 gate), then implement
**Owner model:** spec + target review = Fable; implementation = lean Sonnet
**Prerequisites:** spec 06 (harness — promoted and green), `tools/get-hermesc.sh`,
`tools/e2e/corpus-regression.mjs`, `tools/e2e/oss-benchmark.mjs`
**Consumers:** metrics scoreboard (handoff decision 5, `tools/metrics/`),
`docs/STATUS.md`, every future pass/emitter change

Reference: `docs/orchestrator-handoff-2026-09-02.md` decisions **1, 2, 3, 4, 8**;
`docs/DECISIONS.md` **D5** (INCONCLUSIVE is never PASS), **D14** (bytecode under
the Hermes VM is ground truth), **D15/D16** (harness promotion, tiers);
`docs/specs/06-harness.md` §2 (verdicts, oracle ladder), §7 (tier runners);
`src/harness/ladder.ts` (`runOracleLadder`, `OracleName`), `src/harness/fuzz.ts`
(differential function fuzzing — reused as-is, not rewritten);
`tests/fixtures/constructs/` build convention (`build.sh`); CLAUDE.md testing
rules (no exact-output assertions on shared fixtures; exclusions cite BUGS.md).

> **Ownership notice.** This spec creates no implementation. It defines four
> components (A–D below), their acceptance tests, and their measurable targets
> per decision 8. `tests/fuzz/spec-consistency.test.ts` ships with this spec and
> runs pre-implementation; every other test named in §8 is shipped by the
> implementer at the exact path and with the exact assertion stated there.

---

## 0. Why, in one paragraph

The 57 hand construct fixtures prove the decompiler on constructs someone
thought of; they cannot prove it on constructs nobody thought of, and the
895-bundle corpus has exactly **one** app with a source map, so naming/structure
accuracy is currently tuned and measured on a single ground-truth point. This
spec adds (A) an unbounded, oracle-backed faithfulness fuzzer at the construct
level, (B) an app-generation fuzzer that *builds* apps to mint
`(bundle, map, source)` ground-truth triples across the bundler/version matrix,
(C) a blind held-out set so we measure generalisation instead of memorisation,
and (D) a per-version × per-bundler pass matrix so a regression in one cell can
never hide inside an aggregate.

---

## 1. Component A — construct-level fuzzer (decision 1)

### 1.1 Pipeline

One iteration, all driven from a single 64-bit seed:

```
seed → generate JS program P            (src/fuzzgen/, §1.2)
     → hermesc vNN compile P → P.hbc    (tools/hermesc/vNN/hermesc, per version)
     → decompile P.hbc → D.js           (src/decompile.ts, default pipeline)
     → runOracleLadder(D.js, P.hbc, sourceJsPath = P)   (src/harness/ladder.ts)
     → verdict PASS | DIVERGENT | INCONCLUSIVE | ERROR
```

No new comparison machinery: the existing ladder (syntax → trace → fuzz →
roundtrip) *is* the oracle, including the Hermes-VM reference policy (D14) and
the differential function-fuzz oracle in `src/harness/fuzz.ts`, which covers
generated programs whose behaviour lives in defined-but-uncalled functions.
The fuzzer is a *driver* plus a *generator* plus a *minimiser*.

**Layout.** Generator + minimiser are typed and unit-tested under
`src/fuzzgen/` (`grammar.ts`, `generate.ts`, `mutate.ts`, `minimise.ts`,
`signature.ts`). The driver is `tools/fuzz/construct-fuzz.mjs`
(`--versions 84,94,96,98,99 --count N --seed-base S --out reports/fuzz/…`),
same zero-dependency `.mjs` convention as `tools/e2e/*`.

### 1.2 Generator: grammar + mutation, and how it grows

Two seeded modes, interleaved 50/50 by default:

- **Grammar mode.** A depth- and statement-budgeted generator over an explicit
  JS-subset grammar. The subset is *keyed to the lowering catalogue*: the
  initial grammar covers exactly the construct families the decompiler claims
  (expressions incl. coercion-heavy operators, `if`/loops/`switch`, functions,
  closures, `try/catch/finally`, template literals, default params, spread/rest,
  destructuring, classes, generators, async where supported per version).
  Growth rule: **a grammar production may be added only when its
  `docs/LOWERING-CATALOGUE.md` row is confidence-✅ multi-version**; the grammar
  file carries a `grammarVersion` string (semver-ish) bumped on every production
  change, and every report records it. This makes "we started fuzzing X"
  auditable and keeps early campaigns from drowning in known-unsupported noise.
- **Mutation mode.** Seed corpus = the `source.js` of every fixture under
  `tests/fixtures/constructs/` (a corpus that grows automatically as fixtures
  land). Operators: splice a function from fixture A into fixture B, swap a
  binary/logical/update operator, perturb literals across the semantic fork
  values already enumerated in `src/harness/fuzz.ts`'s `CORPUS` (−0, NaN, `""`,
  `"0"`, `[]`, bigints, `valueOf` objects…), duplicate a statement, wrap a
  region in `try/finally`, convert `var`↔`let` (D14 territory: loop-binding
  and TDZ semantics differ per version — deliberately provocative).

Programs must be deterministic and side-effect-bounded by construction: no
`Date`/`Math.random`/timers/IO in the grammar; top-level drives execution by
calling its own functions and printing values (so the trace oracle sees them).
Determinism requirement: same `(seed, grammarVersion)` → byte-identical program.

### 1.3 Versions, and the v98 rule

hermesc exists for 84/94/96/98/99 (`tools/get-hermesc.sh`). Trace VMs exist for
≤89 (covers 84), 94, 96 and 99 — **none for 98**. Therefore:

- **84, 94, 96, 99 — full ladder** (syntax + trace + fuzz + roundtrip). These
  are the *traced versions*; only they produce PASS/DIVERGENT faithfulness
  verdicts.
- **98 — structural coverage only.** The same generated program is compiled
  with v98 hermesc and run through **syntax + recompile-roundtrip only**
  (`src/harness/roundtrip.ts` normalised-disasm compare). Its matrix cell (§4)
  is reported as `roundtrip-only` — never blended into traced-version pass
  rates, per D5's spirit (an unverifiable cell must look different from a
  verified one). Semantic coverage of a given generated program still exists
  via its 96 and 99 compilations; what stays unmeasured is 98-*specific*
  codegen divergence, and the matrix says so explicitly. If a v98-capable VM
  ever lands, the driver picks it up through `src/harness/hermes-vm.ts`'s
  existing directory probe with zero fuzzer changes.

### 1.4 Minimisation and landing a find

Every DIVERGENT/ERROR find is processed before the campaign may claim its
target:

1. **Signature.** `src/fuzzgen/signature.ts` computes a divergence signature:
   verdict + first-differing-trace-record kind + a small normalised context
   (e.g. opcode/helper name), so 400 instances of one bug dedupe to one.
2. **Minimise.** Seeded delta-debugging at statement then expression
   granularity; a reduction step is kept only if the reduced program still
   yields the *same signature* on the same version. Output target: ≤ 25 source
   lines.
3. **Land.** Per repo hard rules, each unique signature becomes either
   (a) a new construct fixture `tests/fixtures/constructs/NN-fuzz-<slug>/`
   (source + `build.sh`-generated `.hbc` for all five versions) **plus** a
   `docs/BUGS.md` row naming the campaign and seed, or — if it exposes an
   environment/toolchain issue rather than a decompiler bug — a BUGS.md row
   alone. A find is never fixed silently and never left undocumented. Raw
   (unminimised) failing programs are kept only until their fixture lands,
   capped at 200 files per campaign under gitignored `reports/fuzz/finds/`.

### 1.5 Decision-8 quadruple for A

- **(i) Metric.** Divergence rate: DIVERGENT+ERROR verdicts per 1,000 generated
  programs, per traced version (84/94/96/99), plus the count of *unique open
  divergence signatures* (found but not yet fixture-ised or fixed).
- **(ii) Target.** First campaign ≥ **10,000 programs per traced version**.
  Exit criterion, measured on the evaluation range (§1.5.iv, 2,000
  programs/version, run once): **0 novel divergences** — every DIVERGENT/ERROR
  verdict must match an already-triaged signature, i.e. one whose §1.4 landing
  (minimised fixture + `docs/BUGS.md` row) is committed — with **0 open
  unminimised finds** at campaign close and ≤ **5** triaged-but-unfixed
  signatures per version. Volume tripwire: the raw divergence rate on the
  evaluation range must also stay ≤ **5 per 1,000** per version — ledgered
  bugs firing more often than that mean the version is not ready to claim the
  target. *(A pure rate tolerance was considered and rejected at review: the
  project's equivalence claim is trace-oracle 0-DIVERGENT, so a divergence may
  survive a campaign only inside the triage ledger, never inside a tolerance.)*
  Steady state thereafter: nightly run of ≥ 500 programs/version with **0
  novel signatures** (ledgered signatures may re-fire until fixed).
- **(iii) Measurement method.** The driver writes one JSON report per run to
  `reports/fuzz/construct-<UTC date>-<runid>.json` (schema §4.2): per-version
  counts of each verdict, grammarVersion, seed range, signature list. Rates are
  computed from that file by the metrics scoreboard, never hand-tallied.
- **(iv) Held-out check.** Seed discipline: tuning/fix iterations may only use
  seeds in the campaign's *work range* `[S, S+80,000)`; the exit-criterion
  measurement uses the disjoint *evaluation range* `[S+900,000, S+902,000)` per
  version, run once, with `grammarVersion` frozen at the value used for the work
  range. Evaluation-range seeds are never re-run during tuning (the report file
  records every range ever run; the scoreboard flags overlap as a violation).

### 1.6 Run cost and bound for A

- **Wall-clock.** Per program per traced version ≈ 0.1 s compile + ~1–2 s
  decompile+ladder worst case; the driver reuses `tiers.ts`'s worker-pool
  pattern. Bound: default run (500 programs × 5 versions) ≤ **30 min** on deb
  (32 cores) / ≤ 60 min on the Mac; any single run hard-capped at **2 h**
  (driver exits with a partial report, which is valid — counts are per program).
- **Disk.** Per-iteration temp dirs via `mkdtempSync` + `rmSync` in a `finally`
  (same convention as `src/harness/tiers.ts`); nothing persists except the JSON
  report (< 1 MB) and capped raw finds (§1.4). Bound: ≤ **50 MB** persistent per
  campaign, ≤ 200 MB transient at any instant. Runs anywhere (macOS/Linux).

---

## 2. Component B — app-generation fuzzer (decision 2)

### 2.1 What is generated

Both the **app source** and the **build config**, from one seed:

- **Source generator** (`src/appgen/`): template-based, not random-AST — the
  point is realistic *shape* with known ground truth, not semantic edge cases
  (component A owns those). A generated app has 2–6 screens with seeded names
  (wordlist-driven, so names differ across apps), a navigation graph, 0–2 store
  slices, a handful of components/utils, and calls into its configured library
  set. The full generated source tree is part of the triple.
- **Build-config axes** (the matrix):

  | Axis | Values |
  |---|---|
  | framework/template | RN bare | Expo managed |
  | bundler | Metro plain | Metro RAM (indexed) | Expo export |
  | router | none | react-navigation stack/tabs | expo-router (Expo only) |
  | libraries | seeded pick of 1–4 from a fixed pool (redux-toolkit, zustand, axios, dayjs, lodash, styled-components) |
  | RN + Hermes version | pinned RN releases chosen so the emitted HBC versions cover **{94, 96, 98, 99}** |
  | obfuscation | off | minified/mangled (terser via Metro config) |

  The RN-release → HBC-version mapping is **derived, not assumed**: implementer
  probes each pinned RN release's own bundled `hermesc` (under
  `node_modules/react-native/sdks/hermesc` for RN ≤ 0.82; under the
  `hermes-compiler` dependency for RN ≥ 0.83 — see `docs/TOOLCHAIN.md`'s
  distribution-mechanism section) and records the table in `docs/TOOLCHAIN.md`.
  v98 is reachable this way even though we have no v98 VM — that is precisely
  why B, not A, is our main v98 evidence source. Review-confirmed (2026-09-02):
  `react-native@0.86.0` depends on `hermes-compiler@250829098.0.14`, and every
  probed `250829098.0.x` build emits HBC 98 in the **98-late (class E)**
  layout (`docs/TOOLCHAIN.md` v98 probe table), so the v98 triple target is
  satisfiable via RN 0.86–0.87 — but B's v98 evidence covers 98-late only;
  98-early (class D) is not publicly obtainable and stays fixture-level debt.
  Fallback if a pinned RN 0.86/0.87 project fails to build twice: compile the
  Metro bundle of a *buildable* generated app directly with
  `tools/hermesc/v98/hermesc` (same compiler family, same layout) and record
  the triple's `config.json` with `compiler: "direct-hermesc"` so the matrix
  cell is honest about provenance. v84 is legacy and out of scope for B.

### 2.2 No Gradle: how a triple is built cheaply

A triple needs `(bundle, map, source)` — **not an APK**. So the build is:
`npm ci` the generated project → `react-native bundle` (or `expo export`,
or Metro RAM config) with `--sourcemap-output` → compile the JS bundle with the
project's *own* `hermesc` (`-emit-binary -output-source-map`) → compose the
Metro map with the Hermes map (the standard `compose-source-maps.js` step RN's
build runs). No Android SDK, no Gradle, no emulator. This is the single biggest
cost decision in this spec: it turns a ~15 GB toolchain dependency into a
node_modules-sized one and makes the triple exactly what a real release build
ships.

Output per triple, stored under `$HBC2JS_APPGEN_DIR` (default
`~/hbc2js-appgen/triples/<id>/`, **outside the repo**): `bundle.hbc`,
`bundle.map`, `source/` (generated app tree), `config.json` (full axis
fingerprint + seed + RN/Hermes versions), `package-lock.json` (reproducibility
anchor), `hashes.json`. The repo commits only
`tests/fixtures/appgen/manifest.json`: one entry per triple with id,
fingerprint, sha256s, sizes — no bundles in git (repo-size rule; same posture
as `bundles/fetch.sh`).

### 2.3 Sampling, rotation, diversity (never the full matrix)

The full matrix is ~hundreds of cells; a run builds a **sample of 2** configs.
Selection is seeded stratified sampling against the manifest:

1. **Duplicate rejection.** A candidate whose axis fingerprint
   `(rn, bundler, router, sortedLibs, obfuscation)` equals any manifest entry's
   is rejected outright — *same-app-N-times is the defined failure*. Source
   seeds are also never reused, so even a re-visited cell gets a different app.
2. **Axis quota.** Once the manifest holds ≥ 5 triples, no single value of any
   axis may exceed **40 %** of stored triples; the sampler draws until quotas
   hold (or reports "matrix saturated for quota" and picks the least-covered
   cell).
3. **Coverage pressure.** Among quota-passing candidates, prefer the cell with
   the lowest count in the §4 matrix (version × bundler first, then router).

### 2.4 Disk and rotation on deb (free space fluctuates — 35–51 GB observed; the preflight, not a snapshot, is the guard)

Builds run **on deb only** (they are npm-install heavy; construct fuzzing runs
anywhere). Hard bounds, all preflight-enforced by the driver
(`tools/fuzz/appgen.mjs`):

- **Preflight:** refuse to start if free disk < **15 GB**.
- **Transient:** one build at a time; workspace ≤ **6 GB**; the workspace is
  deleted immediately after the triple is extracted and hashed — a triple is
  never "kept as a project". `finally`-guaranteed like §1.6.
- **npm cache:** shared across builds for speed; when it exceeds **5 GB** the
  driver runs `npm cache clean --force` at run end.
- **Persistent triples:** each triple ≤ **40 MB** (bundle+map+source+lockfile);
  the store is capped at **24 triples** (≈ 12 active + held-out + rotation
  slack ⇒ ≤ 1 GB). At the cap, the driver evicts the oldest *non-held-out,
  non-corpus-pinned* triple (manifest keeps the evicted entry marked
  `evicted: true` so the diversity check still sees its fingerprint).
- **Total envelope:** ≤ 6 GB transient + ≤ 6 GB persistent (cache + triples).

### 2.5 Decision-8 quadruple for B

- **(i) Metric.** Two: (a) *ground-truth accuracy* — per-triple naming-closeness
  fuzzy score, classification precision/recall, and structure score, computed
  exactly as `tools/e2e/oss-benchmark.mjs` defines them (reuse, don't
  reimplement — including its classification caveat); (b) *coverage* — number
  of live map-bearing triples and the set of `(HBC version × bundler)` cells
  they occupy.
- **(ii) Target.** ≥ **10 live map-bearing triples** (decision-3 band 8–12)
  covering ≥ **3 HBC versions × all 3 bundler values**, with v98 represented by
  ≥ 1 triple; build-success rate ≥ **80 %** of attempted configs (a config that
  fails to build twice is recorded in the manifest as `unbuildable` with the
  error class, and counts against the rate); decompile→split→segregate
  completes crash-free on ≥ **90 %** of live triples.
- **(iii) Measurement method.** `tools/e2e/appgen-benchmark.mjs` (sibling of
  oss-benchmark, sharing its scoring modules) iterates the manifest's non-held-
  out triples and writes `reports/fuzz/appgen-<UTC date>-<runid>.json` (schema
  §4.2) with the per-triple scores and the coverage matrix. Coverage numbers
  come from the manifest alone (cheap, no build).
- **(iv) Held-out check.** Per §3: every **3rd** triple by creation order is
  flagged held-out at *creation time* (deterministic, never curated). Tuning
  runs score only non-held-out triples; the evaluation run (§3.3) scores the
  held-out ones and reports the generalisation gap. Target: held-out
  ground-truth accuracy ≥ **85 %** of the tuned-set score on the same metric
  (relative), else the gap itself becomes a BUGS.md row.

### 2.6 Run cost and bound for B

- **Wall-clock.** Per triple ≈ 10–25 min (npm ci dominated; deb's 32 cores are
  wasted on npm, which is fine — one build at a time is the disk bound). Bound:
  one run = 2 triples ≤ **1 h**; hard cap 90 min then abort+clean. Cadence:
  ≤ 1 run/night until the 10-triple target is hit, then ~weekly rotation.
- **Disk.** §2.4's envelope: ≤ 6 GB transient, ≤ 6 GB persistent, preflight
  refuses under 15 GB free. Nothing under the repo except the manifest.

---

## 3. Component C — blind held-out set (decision 4)

### 3.1 Membership

Two populations, both selected mechanically (no cherry-picking):

- **Generated apps:** every 3rd triple by manifest creation order (§2.5.iv).
- **Existing corpus:** 5 of the 27 proprietary corpus apps, selected once as
  the 5 lowest values of `sha256(appId + "hbc2js-heldout-v1")`. The repo file
  stores **hashes only** (corpus app ids never enter the repo — standing rule);
  the resolution hash→appId happens inside the evaluator on the machine that
  has `$HBC2JS_CORPUS_DIR`.

### 3.2 Where the list lives and who may read it

`tests/fixtures/appgen/heldout.json` (committed): schema
`{ "schemaVersion": 1, "corpusIdHashes": [...5], "tripleRule": "every-3rd-by-creation", "salt": "hbc2js-heldout-v1" }`.

**Only the evaluation scripts may read it**: `tools/e2e/appgen-benchmark.mjs`
and `tools/e2e/corpus-regression.mjs`, and each only on its explicit
`--heldout` evaluation path. Everything else — every `src/**` module, every
other tool, every tuning-mode run — must not open it, and tuning-mode runs
must *skip* held-out members (corpus-regression's default mode excludes the 5
hashed apps; appgen-benchmark's default mode excludes flagged triples). This is
enforced by a gate test (§8 T6) in the same style as
`tests/gate/passes/imports.test.ts`, not by convention.

### 3.3 Evaluation cadence and reporting generalisation

Held-out evaluation runs are **scheduled, not ad hoc**: at campaign close
(component A), at each new-triple landing (component B), and otherwise at most
weekly. Each writes the `heldout` block of the matrix report (§4.2): tuned-set
score, held-out score, gap = held-out ÷ tuned. The scoreboard shows the gap as
its own trend line. Iterating on a failure *observed on a held-out member* is
the one legitimate reason to rotate it out: the member moves to the tuned set
permanently (recorded in the manifest / a heldout.json version bump) and a
replacement is drawn by the same mechanical rule — a held-out member is never
quietly tuned against.

---

## 4. Component D — reporting: the pass matrix (decision 3)

### 4.1 Shape

One matrix, rows = HBC version (84, 94, 96, 98, 99), columns = source class:

```
construct-fuzz | appgen:metro-plain | appgen:metro-ram | appgen:expo | corpus | fixtures
```

Cell = `{ n, pass, divergent, inconclusive, error, mode }` where `mode` is
`"full-ladder"` or `"roundtrip-only"` (v98's construct-fuzz cell, §1.3) or
`"no-ground-truth"` (corpus cells: plausibility detectors, not equivalence).
INCONCLUSIVE is **never** folded into pass (D5); a cell's headline rate is
`pass / n` with inconclusive shown beside it. Aggregates across cells may be
displayed but never *gate* anything — gates read cells.

### 4.2 Files and consumers

- Raw run reports: gitignored **`reports/fuzz/*.json`**, one file per run,
  self-describing: `{ "schema": "fuzz-matrix/1", "component": "construct" |
  "appgen" | "corpus", "date", "runId", "grammarVersion"?, "seedRanges"?,
  "cells": [...], "heldout"?: { tuned, heldout, gap } }`.
- **Producers:** `tools/fuzz/construct-fuzz.mjs`, `tools/e2e/appgen-benchmark.mjs`,
  and `tools/e2e/corpus-regression.mjs` — the latter gains a `--matrix` flag
  that groups its existing per-app results by detected HBC version and bundle
  kind (it already detects RAM vs plain) and emits the same schema. Its default
  human output and existing flags are unchanged (no existing assertion moves).
- **Consumer:** the metrics scoreboard (decision 5, `tools/metrics/`, being
  built concurrently) reads the newest `reports/fuzz/*.json` per component and
  renders per-cell trend rows. The schema string is the contract: scoreboard
  code matches on `"fuzz-matrix/1"` and ignores files it doesn't understand,
  so the two efforts can land in either order.
- **Committed-record rule (review, 2026-09-02).** Raw run reports stay
  gitignored and machine-local (the implementer adds the `reports/` ignore
  entry — it is not in `.gitignore` today). The *committed* record is the
  scoreboard row in `docs/reports/metrics/scoreboard.md` (plus, for B, the
  committed `manifest.json`): whichever numbers the collector extracts from a
  `reports/fuzz/*.json` file are embedded in the committed row itself, so a
  reader never needs a gitignored file to interpret history. Landing rule: a
  campaign close or new-triple landing runs the collector **on the machine
  holding the report**, in the same landed unit. No committed mirror of
  `reports/fuzz/` — snapshots would be golden-file debt (regeneration needs
  Fred's approval per CLAUDE.md) with no reader.

---

## 5. What this spec deliberately does not do

- No semantic fuzzing of *library* code paths (appgen apps call libraries, but
  divergence grading there is oss-benchmark-style structure/naming, not traces).
- No full-matrix builds, ever — rotation only (decision 2's explicit rule).
- No growth of the 27-app proprietary corpus for count (decision 3): B fixes
  the *ground-truth* gap; the corpus stays the drift detector it is.
- No new comparison/verdict machinery: A composes `runOracleLadder`; B composes
  oss-benchmark's scorers. If either needs a change in `src/harness/**`, that
  is its own reviewed task, not a side effect of this one.
- No v98 trace VM work (tracked separately in docs/STATUS.md's toolchain queue);
  §1.3 defines honest reporting in its absence.

## 6. Failure/abuse modes considered

- **Generator collapse** (grammar mode emitting near-identical programs):
  caught by T2's distinct-program assertion and by the signature dedupe rate in
  reports (a run where >50 % of programs share one shape hash is flagged).
- **Overfitting to the fuzzer** (fixing finds by special-casing generator
  idioms): every find lands as a *fixture* built for all five versions and run
  through the ordinary gate — the fix has to survive the same harness as
  hand-written fixtures, and held-out seed ranges (§1.5.iv) catch tuning-range
  memorisation.
- **deb disk exhaustion:** §2.4 preflight + finally-cleanup + triple cap; the
  driver never starts what it cannot clean up.
- **Ecosystem drift** (an RN release's transitive deps break `npm ci`): the
  lockfile in each triple pins what *was* built; `unbuildable` manifest entries
  keep the sampler from banging on a dead cell; build-success target (§2.5.ii)
  tolerates 20 % attrition.
- **Held-out leakage via logs:** evaluation runs print scores and hashes only,
  never held-out corpus app ids (corpus-regression's existing "generic tokens
  only" rule already covers this).

## 7. Sequencing

1. `src/fuzzgen/` generator + minimiser + unit tests (T2, T3) — pure, no
   toolchain needed.
2. `tools/fuzz/construct-fuzz.mjs` driver + report schema + T4; first campaign
   on traced versions; v98 roundtrip-only lane.
3. `heldout.json` + evaluator `--heldout` paths + isolation test T6.
4. `src/appgen/` + `tools/fuzz/appgen.mjs` (deb only) + T5; mint triples to
   the 10-triple target; `tools/e2e/appgen-benchmark.mjs`.
5. `corpus-regression.mjs --matrix` + scoreboard consumption (coordinate with
   the metrics task; schema is the only shared surface).

Each step is its own landed task with its own tests; step 1–2 (decision 1,
"MUST, prioritise") ship before any of 3–5.

---

## 8. Acceptance tests

Per CLAUDE.md, the spec agent writes the acceptance tests. T1 ships **with this
spec** and runs today; T2–T7 are specified here precisely (path + assertion) and
ship with the implementation steps in §7. None of them asserts exact output on
any shared fixture under `tests/fixtures/constructs/**`. `tests/fuzz/` is run
via `node --test "tests/fuzz/**/*.test.ts"` (the implementer adds a `test:fuzz` npm script
and folds T1/T6-style checks into the gate glob in their own landing — this
spec's author does not edit `package.json` or `tests/gate/**`).

- **T1 (ships now)** `tests/fuzz/spec-consistency.test.ts`: reads this file and
  asserts the decision-8 contract is present and stays present — for each of
  §1.5 and §2.5 all four labelled items `(i) Metric` … `(iv) Held-out check`
  exist; §1.6 and §2.6 each contain both a wall-clock and a disk bound with a
  numeric cap; §1.3 states the v98 `roundtrip-only` rule; §2.4 contains the
  preflight free-disk number. Pure self-consistency: it keeps later edits from
  silently deleting the reviewable targets.
- **T2** `tests/fuzz/generator.test.ts`: (a) determinism — same
  `(seed, grammarVersion)` yields byte-identical program text across two calls;
  (b) 100 consecutive seeds yield ≥ 95 distinct program texts; (c) every
  generated program passes `node --check`; (d) a construct scanner over 100
  programs finds no token outside the grammar allowlist (no `Math.random`,
  `Date`, `setTimeout`, `require`, `import`).
- **T3** `tests/fuzz/minimise.test.ts`: on a *fuzz-private* fixture pair under
  `tests/fuzz/fixtures/` (a synthetic program + a fake ladder stub returning
  DIVERGENT iff a marker statement is present), the minimiser (a) returns a
  program that still triggers the signature, (b) is ≤ the input's statement
  count, (c) is idempotent (minimising the minimum returns it unchanged).
- **T4** `tests/fuzz/matrix-schema.test.ts`: a driver-produced report object
  validates the `fuzz-matrix/1` schema; a cell with
  `inconclusive > 0, pass = n − inconclusive` does **not** report rate 1.0
  (D5 encoded); a v98 construct cell must carry `mode: "roundtrip-only"`.
- **T5** `tests/fuzz/appgen-config.test.ts` (samplers/preflight are pure
  functions taking injected manifest + fs-stats): (a) a candidate equal to a
  stored fingerprint is rejected; (b) with 5 stored triples all on
  `metro-plain`, the sampler refuses a 6th `metro-plain` (40 % axis quota);
  (c) preflight with injected free-disk 14 GB refuses, 16 GB proceeds; (d) at
  the 24-triple cap the eviction choice is the oldest non-held-out entry.
- **T6** `tests/fuzz/heldout-isolation.test.ts` (gate-style, mirrors
  `tests/gate/passes/imports.test.ts`): greps `src/**` and `tools/**` for the
  string `heldout.json`; the only files allowed to contain it are
  `tools/e2e/appgen-benchmark.mjs` and `tools/e2e/corpus-regression.mjs`; also
  asserts in each that the read is guarded by an explicit `--heldout` flag
  check (regex on the surrounding lines, not exact output).
- **T7** (regression convention, not one file): every fuzz find that becomes a
  fixture follows the existing fixture rules — built for all five versions by
  `build.sh`, BUGS.md row citing campaign + seed, and no rung/exclusion table
  entry without that row (already enforced by
  `tests/gate/docs/testing-rules.test.ts`; nothing new to write, listed here so
  the implementer doesn't invent a parallel convention).

## 9. Review responses

*(reviewer appends here — decision-8 gate: verify §1.5/§2.5 quadruples exist
and the targets are sane before implementation launches)*

### Review responses (2026-09-02, Fable reviewer gate)

**Verdict: APPROVED** — with the four required edits already applied in-place
by the reviewer (listed below, all target/reporting clarifications; none is
design-changing). Implementation of the construct fuzzer (§7 steps 1–2) may
launch.

**Checklist findings.**

1. *Decision-8 completeness.* Both quadruples present and labelled
   (§1.5, §2.5), guarded by the already-shipped T1
   (`tests/fuzz/spec-consistency.test.ts`). One internal inconsistency found
   and fixed (edit E1): §1.5.ii measured the exit criterion "over the final
   2,000 programs of the campaign" while §1.5.iv defined a *disjoint*
   evaluation range `[S+900,000, S+902,000)`. The exit criterion now measures
   on the §1.5.iv evaluation range, as the held-out discipline requires.
2. *Sanity of the divergence bar (spec open question 1 — answered).* The
   ≤ 5/1,000 tolerance as originally worded was **not** the right bar: the
   project's equivalence claim is trace-oracle 0-DIVERGENT on fixtures, and a
   rate tolerance lets up to ~10 divergences per version pass campaign close
   without anything forcing them into the ledger. Ruling (edit E1): the bar is
   **0 with a triaged-exclusion ledger** — 0 *novel* divergences on the
   evaluation range; any divergence that does appear must match an
   already-triaged signature whose minimised fixture + BUGS.md row are
   committed (§1.4); ≤ 5 triaged-but-unfixed signatures per version at close;
   and the raw rate ≤ 5/1,000 is retained only as a volume tripwire. This
   reconciles ethos (no divergence survives outside the ledger) with realism
   (a hard-to-fix bug does not block the campaign, it blocks silently ignoring
   the bug). Nightly steady state likewise: 0 novel signatures.
3. *v98 obtainability (spec open question 2 — answered).* Confirmed real, not
   aspirational: `docs/TOOLCHAIN.md` records that `react-native@0.86.0`
   depends on `hermes-compiler@250829098.0.14`, and every probed
   `250829098.0.x` build emits HBC 98 — so RN 0.86–0.87 projects yield v98
   triples via the §2.2 pipeline. The `tools/get-hermesc.sh` caveat means all
   obtainable v98 output is the **98-late / class E** layout
   (`docs/HBC-FORMAT.md` layout table); 98-early (class D) is publicly
   unobtainable and remains fixture-level coverage only — B cannot and need
   not fix that. Two edits applied (E2): the probe path corrected (hermesc
   lives in the `hermes-compiler` dep for RN ≥ 0.83, not `sdks/hermesc`), and
   a fallback specified — if a pinned RN 0.86/0.87 config is `unbuildable`
   twice, compile a buildable generated app's Metro bundle directly with
   `tools/hermesc/v98/hermesc`, marking `compiler: "direct-hermesc"` in the
   triple's config so provenance stays honest.
4. *Reports vs committed snapshots (spec open question 3 — answered).* Ruling
   (edit E4, §4.2 "Committed-record rule"): raw `reports/fuzz/*.json` stay
   gitignored (note: `reports/` is **not** in `.gitignore` today — the
   implementer adds it in step 2); the committed record is the scoreboard row
   in `docs/reports/metrics/scoreboard.md` (one row/day convention,
   `tools/metrics/collect.mjs`) plus B's committed `manifest.json`. Rows must
   embed the numbers they report — no committed row may require a gitignored
   file to interpret — and campaign-close / triple-landing runs the collector
   on the machine holding the report. No committed mirror of `reports/fuzz/`:
   that would be golden-file debt with no reader.
5. *Feasibility.* Seed-range held-out discipline is enforceable in the stated
   soft form (reports record every range; scoreboard flags overlap) and the
   hard heldout.json isolation has a real gate test (T6, grep-style like
   `tests/gate/passes/imports.test.ts`). Diversity is concretely defined
   (fingerprint rejection + 40 % axis quota + coverage pressure, §2.3). Disk
   preflight (< 15 GB refuse) is consistent with observed free space (35–51 GB
   fluctuating; §2.4 heading updated, edit E3, so the snapshot figure can't
   read as a guarantee). v98 roundtrip-only is structurally prevented from
   blending into traced rates: distinct `mode` in the cell schema, asserted by
   T4, and §4.1 says aggregates never gate. Minimised finds land as ordinary
   construct fixtures + BUGS rows (§1.4, T7) per repo hard rules.
6. *Truth-first.* No faithfulness-for-cost trades found. INCONCLUSIVE is never
   PASS (§4.1 headline-rate rule + T4's explicit D5 assertion); the biggest
   cost decision (no Gradle, §2.2) produces exactly what a release build ships,
   so it does not weaken ground truth; partial reports from the 2 h cap remain
   valid because all metrics are per-program counts.

**Edits applied by the reviewer (all in this commit).**

- **E1** §1.5.ii — exit criterion re-based onto the §1.5.iv evaluation range;
  bar changed from a rate tolerance to 0-novel-divergences with a triaged
  ledger (≤ 5 open triaged signatures/version); rate ≤ 5/1,000 kept as volume
  tripwire; steady state = 0 novel signatures. (T1's pinned target strings
  `10,000 programs` and `5 per 1,000` are preserved.)
- **E2** §2.1 — RN ≥ 0.83 probe path corrected to the `hermes-compiler`
  dependency; v98 obtainability confirmed with the 98-late-only caveat; direct
  `tools/hermesc/v98` fallback with `compiler: "direct-hermesc"` provenance.
- **E3** §2.4 heading — free-disk snapshot replaced with the fluctuation range
  and a pointer that the preflight is the guard.
- **E4** §4.2 — committed-record rule added (gitignored raw reports,
  self-contained committed scoreboard rows, collector runs where the report
  lives, no committed report mirror); notes `reports/` must be added to
  `.gitignore` by the implementer.

**No REQUIRED edits remain open.** T1 passes against the edited spec by
construction (quadruple labels, bound sections, and pinned numeric strings all
retained).
