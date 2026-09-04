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
  Each traced version's cell also records which reference engine actually
  ran (`referenceEngine: "hermes-vm" | "expected-txt" | "node-source"`,
  `src/harness/reference-policy.ts`'s `chooseReference`), and the driver
  prints one banner line per version at start (`v96: reference engine =
  expected-txt (no Hermes VM found) — …`). `mode` is `"full-ladder"` **only**
  when the engine is `hermes-vm`; if a traced version's host has no matching
  VM the cell is `mode: "full-ladder-no-vm"` instead — same oracle set, but
  pass/divergent counts are Node-vs-decompiler, not a Hermes-VM cross-check
  (D14), and must be read accordingly. Found the hard way: `docs/reports/
  2026-09-05-campaign2-rediff.md` originally reported every v96 cell as
  `full-ladder` on a deb host that had no v96 VM at all — corrected in
  `docs/reports/2026-09-05-campaign2-v96-vm-rediff.md`, which is also where
  this label was introduced.
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

### Report writing is streamed (docs/BUGS.md 2026-09-03)

The driver used to accumulate every divergence/error signature (unbounded
trace-context strings) in memory and write the whole report with one
`JSON.stringify` at the end; at campaign scale (40k programs, 201 finds)
that threw `RangeError: Invalid string length` and lost the aggregate
`cells` matrix after 5h of compute, even though the per-find files under
`reports/fuzz/finds/*.js` survived. Fixed in `tools/fuzz/campaign-report.mjs`
(used by `construct-fuzz.mjs`, unit-tested directly in
`tests/fuzz/campaign-report.test.ts` without running a real campaign):

- Every DIVERGENT/ERROR signature is appended, as it occurs, to
  `<out>.signatures.jsonl` (one JSON object per line: `version`, `seed`,
  `verdict`, a capped `signature` string, and the `find` path if one was
  written) — this file is complete even if the process is killed mid-run.
- The summary JSON at `--out` always writes successfully: it inlines a
  capped sample of distinct signatures (`signatures[]`, `signatureCount`,
  `signaturesFile` pointing at the JSONL) and falls back to a smaller inline
  sample (`signaturesTruncated: true`) rather than ever failing the final
  write.
- `--recount [--finds-dir DIR]` re-derives a best-effort per-version
  `cells` count from `reports/fuzz/finds/` filenames alone (`v<version>-
  seed<seed>.js`) — the recovery path for a summary lost before this fix,
  when only `finds/` survived. It cannot recover `n`/`pass`/`inconclusive`
  (not encoded in a filename), only a per-version failure count, and only
  up to the run's 200-find cap. Run against the actual campaign-1 finds
  still on disk, it reproduces the incident's own numbers exactly:
  `v84:50/v94:46/v96:45/v98:1/v99:59` (total 201).

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

## Harness gaps blocking the first real campaign — fixed 2026-09-02

The first real seed-base-777000 triage run (`docs/BUGS.md`) surfaced three
harness gaps, not decompiler bugs, that produced false DIVERGENT/ERROR
verdicts on fuzz-generated (nameless) programs. All three are fixed as of
2026-09-02 — see `docs/BUGS.md`'s Resolved table for the full writeups:

- **D14 VM-agrees-with-candidate override was curated-name-gated.**
  `src/harness/ladder.ts`'s D14 cross-check only downgraded a DIVERGENT
  Node-vs-candidate verdict to PASS-with-caveat when the fixture's *name*
  was in `reference-policy.ts`'s hand-curated `KNOWN_DIVERGENT_FIXTURES`
  table — a fuzz-generated program can never have a name in that table in
  advance. The override is now evidence-based: it fires whenever a Hermes
  VM actually ran and its own trace of the original bytecode matched the
  candidate byte-for-byte (`vmAgreesEvidence`), for any program. The
  curated list remains only as the fallback when no VM exists for the
  version (e.g. v98) — the override never fires on missing evidence, so a
  genuine candidate-vs-VM disagreement (e.g.
  `tests/fixtures/adversarial/43-fuzz-async-guard-shared-range`, a real
  open bug) still reports DIVERGENT.
- **Mutation mode had no version awareness.** `src/fuzzgen/mutate.ts`
  never consulted a corpus fixture's `versions.txt`, so a class-shaped
  mutation could be handed to a v94 hermesc that has never supported
  classes — a driver ERROR that was really "hermesc correctly rejected
  code this version was never meant to compile". `corpusSources`/
  `mutateFromCorpus` now take an optional target HBC version (mirroring
  `src/harness/tiers.ts`'s `readVersionsTxt`) and skip any fixture whose
  `versions.txt` marks that version FAILS.
- **Thrown-error message text was exact-compared.** The trace comparator
  (`src/harness/compare.ts`) used to fail a comparison solely because an
  engine-generated error message embedded an identifier the decompiler's
  naming passes could not — or, without debug info, could never —
  reproduce verbatim. `err`/`unhandled` records now compare by
  constructor name and thrown-vs-not-thrown exactly, with
  identifier-shaped tokens in the message masked (conservative — a
  small template-word allowlist keeps `is not a function`,
  `undefined`/`null`, etc. literal). A masked-only match is never a
  silent pass: it is recorded in `TraceComparison.maskedMatches` and
  surfaced as a distinct caveat by `ladder.ts`.

Re-running the row-1 repro (`node tools/fuzz/construct-fuzz.mjs --versions
94,99 --count 30 --seed-base 777000`) after all three fixes: v94 30/30
PASS, 0 DIVERGENT, 0 ERROR (previously 3 DIVERGENT + 2 ERROR); v99 29/30
PASS, 1 DIVERGENT — seed 777007, the one genuine, still-open decompiler bug
in this campaign (tracked separately in `docs/BUGS.md`).

## Campaign 1 (2026-09-02) — first ≥10,000-programs-per-version run

`tools/fuzz/campaign-runner.sh` is a chunked, resumable wrapper around the
driver (§1.5.ii target). It runs on `deb` (repo checked out at `~/hbc2js`,
node 22 via `fnm exec --using 22`, per `docs/DEB-CI.md`'s convention),
chunks each traced version's 10,000 programs into 500-program driver
invocations, and tracks per-version progress in
`~/hbc2js-fuzz/campaign1/state/v<version>.count` so it can be killed and
re-run at any time without re-running a seed or touching the evaluation
range (work range only, per §1.5.iv — see the script's header comment for
the exact seed-base arithmetic). v98 gets the same treatment but its cells
report `mode: "roundtrip-only"` per §1.3; it is included in `--versions` for
structural coverage, not blended into the traced pass rate.

Per-chunk JSON reports land in `~/hbc2js-fuzz/campaign1/reports/`, logs in
`.../logs/`, raw DIVERGENT/ERROR programs are relocated out of the repo's
gitignored `reports/fuzz/finds/` into `~/hbc2js-fuzz/campaign1/finds/` (capped
at 200 total, oldest evicted) after every chunk.

**Launch (first run):**
```
ssh -f deb 'setsid bash -lc "cd ~/hbc2js && git pull -q && \
  tools/fuzz/campaign-runner.sh --seed-base 1000000 --versions 84,94,96,98,99 \
  --chunk-size 500 --target 10000" < /dev/null > /dev/null 2>&1'
```
(Adjust `--versions` down to whichever traced versions actually have a VM
present on deb — verify with `ls tools/hermes-vm/` before launch; never
silently substitute roundtrip-only for a missing trace VM, per this task's
brief. 98 always runs roundtrip-only regardless of VM presence.)

**Status:**
```
ssh deb 'for f in ~/hbc2js-fuzz/campaign1/state/v*.count; do echo "$f: $(cat "$f")"; done'
ssh deb 'ls ~/hbc2js-fuzz/campaign1/reports | wc -l; tail -5 ~/hbc2js-fuzz/campaign1/logs/*.log 2>/dev/null | tail -20'
```

**Resume** (same command as launch — state files make it a no-op past the
target, and pick up mid-target otherwise):
```
ssh -f deb 'setsid bash -lc "cd ~/hbc2js && tools/fuzz/campaign-runner.sh \
  --seed-base 1000000 --versions 84,94,96,98,99" < /dev/null > /dev/null 2>&1'
```

**Kill:**
```
ssh deb 'pkill -f campaign-runner.sh'
```

**Campaign close** (not part of this task — a follow-up once all versions
hit 10,000 work-range programs): per §1.4/§1.5, every unique divergence
signature seen across the whole work-range run must be triaged first —
each becomes either a new `tests/fixtures/constructs/NN-fuzz-<slug>/`
fixture + a `docs/BUGS.md` row, or a `docs/BUGS.md` row alone for a
toolchain issue — with zero open unminimised finds left in
`~/hbc2js-fuzz/campaign1/finds/`. Only after that triage is complete does the
one-shot, never-repeated evaluation-range run happen
(`node tools/fuzz/construct-fuzz.mjs --eval --seed-base 1000000 --versions
<traced> --count 2000`), whose exit criterion is 0 novel divergences and
≤5 triaged-but-unfixed signatures per version (§1.5.ii).

**2026-09-02 kickoff attempt:** blocked before preflight — `deb.local` did
not resolve from this session (`ssh: Could not resolve hostname deb.local`,
confirmed via direct `ssh`/`ping`/`dscacheutil` from this sandbox; general
internet DNS worked, ruling out a total network outage). The runner script
above is written, syntax-checked, and smoke-tested locally (macOS, v94,
7 programs across 3 chunks incl. a resume-is-a-no-op check) with the
committed driver unmodified — only the campaign-dir chunking/state logic
was exercised, so actual preflight (hermesc/VM presence on deb, disk) and
the first real chunk are still outstanding. Next session: retry `ssh deb`
first; if `deb.local` still fails to resolve, that is an environment/network
issue outside this repo (check host is awake, on the same LAN/mDNS domain,
and that no VPN is intercepting `.local` resolution) before assuming
anything about the campaign itself.

## Morning after a campaign

`tools/fuzz/diff-signatures.mjs` turns a night's worth of `campaign-runner.sh`
chunk reports into a one-page triage headline: how many programs each
version ran, and which divergence signatures are already known (tracked in
`tools/fuzz/known-signatures.json`, 64 entries seeded from
`docs/reports/2026-09-04-finds-retriage-postfix.md`) versus genuinely new.
It reads `reports/*.json` under each given campaign directory — never find
bodies — so it stays cheap even across thousands of finds and hundreds of
chunk reports. Exit code is always 0; it is a report, not a gate.

Deb layout (`campaign-runner.sh`'s `~/hbc2js-fuzz/campaign2-v<ver>-<seedbase>/
{reports,finds,state}`):

```
node tools/fuzz/diff-signatures.mjs ~/hbc2js-fuzz/campaign2-* \
     --out docs/reports/<date>-campaign2-signatures.md
```

Add `--known <path>` to compare against a different known-signatures file
(default `tools/fuzz/known-signatures.json`). The generated markdown has a
per-version pass/divergent/error table, a **NEW signatures** section (the
headline — triage these into `tests/fixtures/constructs/` fixtures or
`docs/BUGS.md` rows per the minimisation steps above), and a **KNOWN
signatures still firing** section for signatures already tracked.

Two caveats baked into the tool, because the `fuzz-matrix/1` schema does not
carry them: a report's `signatures[]` is a flat set for the whole
report/chunk, not linked to the specific version/seed that produced each
one, so a NEW signature's "version(s)" is the union of every version that
chunk covered; and the "example find" column is a heuristic (first find file
on disk whose version matches) rather than a verified repro — re-minimise
before trusting it as the actual reproducing program.

Regenerate `known-signatures.json` from a future retriage report the same
way it was first built:

```
node tools/fuzz/diff-signatures.mjs --extract docs/reports/<date>-retriage.md \
     --out tools/fuzz/known-signatures.json
```
