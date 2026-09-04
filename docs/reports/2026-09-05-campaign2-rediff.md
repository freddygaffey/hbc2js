# Campaign-2 signature re-diff after P-16 + fix-wave-3 — 2026-09-05

> **Correction (2026-09-05, `docs/reports/2026-09-05-campaign2-v96-vm-rediff.md`):**
> every v96 cell below is labelled `mode: "full-ladder"` but was actually run
> against `expected-txt` (Node), not a real Hermes VM — deb had `hermesc` for
> v96 but no `hermes` interpreter, and `chooseReference()` silently fell back
> rather than failing loud. A real v96 VM was subsequently built on deb
> (`tools/build-hermes-vm.sh 96`) and every v96 finding here re-verified
> against it: **all 617 raw v96 divergences in the 4,000-seed sample below,
> and all 400 saved v96 finds, are Node-vs-old-Hermes semantic differences
> (D14), not decompiler bugs** — 0/400 DIVERGENT under the real VM. This
> includes every v96-only family in the table below
> (`TDZ/ReferenceError-value`, `unexpected-ReferenceError-missing-global`,
> `other-cannot-read-props`, `iterable-wording`, `cleanup-push-undefined`,
> `rest-args-length`, `globals-dump-mismatch`) and the v96 members of
> `let-closures-capture` and `arity/arguments-aliasing`. The 15.4% v96
> "divergent" figure and the numbers/tables below that derive from it should
> be read as historical (pre-fix) only; see the linked report for the
> corrected numbers, the harness fix that makes this mislabelling impossible
> going forward (`mode: "full-ladder-no-vm"`), and the proposed `docs/BUGS.md`
> row moves.

Supersedes `docs/reports/2026-09-04-campaign2-signatures.md` (see the note
added at the top of that file). Lean worker, compute on `deb` (`ssh deb`,
non-interactive, own clone `~/hbc2js-rediff`), report written locally.

## Headline finding: the live campaign2 runners never got the harness fixes

`deb`'s `~/hbc2js` — the checkout the 8 live `campaign2-*` `campaign-runner.sh`
processes actually run from (confirmed via `/proc/<pid>/cwd`) — is at
**`59beb64` (2026-09-04 22:00:16 +1000, "fuzz: campaign-runner MAX_FINDS
env-overridable for long deb campaigns")**. That commit does **not** contain
either fix the previous report was measured against:

- `b5362b0` (P-16, "a budget cut-off is INCONCLUSIVE, never DIVERGENT",
  `src/harness/ladder.ts` + `compare.ts`)
- `5509ee5` (fix-wave step 3A+3B, resource-ceiling marker + missing-global
  wording normalisation)

`git merge-base --is-ancestor b5362b0 HEAD` / same for `5509ee5`, run inside
`deb`'s `~/hbc2js`, both fail with `fatal: Not a valid object name` — the
commits are not merely unmerged, deb's `origin` never fetched them at all
(same root cause the previous report's own preamble flagged in passing:
"`deb`'s `origin` for `~/hbc2js` was behind the commit that introduced this
tool"). **Every one of the 252,000+ programs the live campaign2 runners have
classified so far (`reports/*.json` under `~/hbc2js-fuzz/campaign2-*`) was
therefore classified pre-fix** — the previous report's 6,118 "new signatures"
figure, and everything downstream of it, measured the P-16 truncation
artifact and the F3 wording family, not decompiler behaviour, exactly as
`docs/reports/2026-09-04-finds-reclassified-post-fixwave3.md` already showed
for the smaller campaign-1 sample. `~/hbc2js` was **not** touched or
restarted by this task (per the brief) — it is simply reported as stale.

## What this task did instead

`tools/fuzz/diff-signatures.mjs` is confirmed (from its own file header and
by reading it) to be a pure aggregator over already-written `reports/*.json`
— it does not re-execute anything, so it cannot itself produce "post-fix
truth" from campaign2's existing (pre-fix) report files. Per the brief's
fallback, this task re-ran classification with the current harness instead
of trusting the saved reports.

Own clone `~/hbc2js-rediff` on `deb`, brought to local main **`06f45c7`**
(descendant of `f0500d0`, includes both fixes) via `git bundle` (deb's own
`origin` is also behind, so the bundle went through the requesting machine,
not `git diff | git apply`, which is simpler for a full-history sync and
was explicitly allowed as a fallback). `tools/hermesc`, `tools/hermes-vm`,
`node_modules` symlinked from `~/hbc2js`, node
`/home/fred/.local/share/fnm/node-versions/v22.23.2/installation/bin/node`
(v22.23.2, not deb's default v18.19.1).

A **full 252k-program re-run was out of scope for a lean worker's compute
budget** (v84 alone runs ~100x slower per seed than v94/96/99, confirmed
live — see "Runner status" below). Instead:

1. **8 bounded samples**, `node tools/fuzz/construct-fuzz.mjs --versions <v>
   --count 2000 --seed-base <2000000|3000000>`, one per (version, seed-base)
   pair campaign2 already covers — i.e. the *same* first 2,000 seeds of each
   campaign's own range, so the sample is directly comparable to campaign2's
   own numbers for that range, not an independent corpus. `nice -n 10`,
   8-way parallel (the brief's cap), run **on top of** the 6 still-live
   campaign2 runners (v84 x2, v94 x2, v99 x2 were still alive at launch;
   v96's had already finished). v94/v96/v99 (6 of 8) completed in
   ~10 minutes; **v84's two jobs did not finish within the ~90-minute
   bounded wait and are reported as partial** (see below) — left running
   detached, undisturbed, not blocking this report.
2. `reports/fuzz/finds/*.js` (the shared, cap-per-process find dir) landed
   **461 real, reproducible programs** during the 6 finished samples (400 for
   v96 — both its 2000-seed processes hit the per-process 200-find cap
   independently, since the cap check races across concurrently-launched
   processes sharing one `REPO_ROOT`; 49 v99, 10 v94, 2 v84). Every one of
   these was re-run through `tools/fuzz/reclassify-finds.mjs` (compile →
   decompile → `runOracleLadder`, the current — patched — harness).
3. Spot-checked 4 of the *old* report's top-10 example seeds individually
   (single-seed `construct-fuzz.mjs` runs) as a direct before/after check.

## Before/after on the old report's own top-10 examples

| seed (old report's "example") | old report cited it for | post-fix verdict |
|---|---|---|
| `v94-seed2000493.js` | 7 of the old top-10 "new signatures" (#1,2,3,4,5,6,10) | **PASS** |
| `v99-seed2000012.js` | old #7 | **PASS** |
| `v94-seed2000569.js` | old #9 | **PASS** |
| `v96-seed2000468.js` | old #8 | **still DIVERGENT** — but a real bug (see `iterable-wording` family below), not a P-16/F3 artifact |

One seed (`v94-seed2000493`) was, on its own, the cited "example" for 7 of
the old top-10 rows — a single non-terminating/truncated program producing
one spurious signature per chunk-boundary it happened to be cut at, exactly
the P-16 failure mode. It is `PASS` under the fixed harness.

## Post-fix sample counts (2,000 seeds/version/base, same ranges campaign2 already ran)

| version | programs | pass | divergent | inconclusive | pass rate | campaign2's own (pre-fix, same-shaped totals, whole campaign so far) |
|---|---|---|---|---|---|---|
| v94 | 4,000 | 3,916 | 10 (0.25%) | 74 (1.85%) | 97.9% | 80,000 programs, 1.19% divergent, 1.06% inconclusive (pre-fix) |
| v96 | 4,000 | 3,310 | 617 (15.4%) | 73 (1.8%) | 82.8% | 80,000 programs, 15.8% divergent, 1.2% inconclusive (pre-fix) |
| v99 | 4,000 | 3,890 | 49 (1.2%) | 61 (1.5%) | 97.3% | 80,000 programs, 2.6% divergent, 0.9% inconclusive (pre-fix) |
| v84 | 0 landed / 2 jobs still running | — | — | — | — | 12,000 programs, 0.4% divergent (pre-fix) |

**v94's divergent rate dropped ~5x (1.19% → 0.25%) and v99's ~2x (2.6% →
1.2%)** — consistent with P-16/F3 eliminating a large share of the false
positives on those versions. **v96's divergent rate barely moved (15.8% →
15.4%)** — v96 has a large population of *genuine* divergences the harness
fix does not touch; see the family table below.

461/461 saved finds were re-classifiable; **460 still DIVERGENT, 1 flipped
to PASS (false alarm)**, 349 distinct signatures. This is close to the
*opposite* ratio of campaign-1's post-fix reclassification (9 survivors of
201, `docs/reports/2026-09-04-finds-reclassified-post-fixwave3.md`) — this
sample's finds are concentrated in v96 (400/461) and campaign2's construct
range hits real bugs at a much higher rate than campaign-1's did.

## New vs `tools/fuzz/known-signatures.json`

Ran `tools/fuzz/diff-signatures.mjs` over the 6 finished samples (arranged
as `<sample>/reports/*.json` per the tool's expected layout): **510 NEW
signatures, 0 of the 64 known signatures still firing** in this sample (the
64 known survivors were retriaged from campaign-1's construct range and a
different seed base; campaign2's 2,000,000/3,000,000 seed-base grammar
produces entirely disjoint concrete signature text even where the
underlying bug is the same class, e.g. `let-closures-capture` below
corresponds to the already-known F2 row). The union of raw (untruncated)
signatures across the 6 samples is 576; the diff tool's 300-char truncation
for known-signature comparison collapses this to 510.

## Families (from the 460 still-DIVERGENT reclassified finds, 349 signatures)

Clustered by wording pattern in the trace diff (same approach as
`docs/reports/2026-09-04-fuzz-families.md`), sorted by find count. All are
full-ladder (VM-cross-check) mode, so a residual DIVERGENT here means the
**decompiled candidate disagrees with the real Hermes VM's own execution of
the same bytecode** — not a Node-vs-Hermes D14 semantic difference.

| family | finds | sigs | versions | example seed | 3-line excerpt |
|---|---|---|---|---|---|
| `TDZ/ReferenceError-value` | 158 | 139 | 96 | `v96-seed2000000.js` | `0 - out print "undefined" ["undefined"]` / `0 + out print "caught: ReferenceError true" [...]` / `1 out print "after declaration: now-initialized" [...]` |
| `unexpected-ReferenceError-missing-global` | 61 | 61 | 96 | `v96-seed2000012.js` | `7 - out print "true" ["true"]` / `7 + out print "f2 threw ReferenceError: t3 is not defined" [...]` (candidate throws where VM does not) |
| `other-cannot-read-props` | 38 | 38 | 96 | `v96-seed2000034.js` | `59 call screen#0() throws TypeError: Cannot read properties of undefined (reading 'map')` / `60 call screen#1(undefined,undefined,undefined) throws same` / `61 call screen#2(undefined,"0",[]) -> [...]` |
| `let-closures-capture` | 21 | 9 | 96,99 | `v96-seed2000016.js` | matches known F2 (`docs/BUGS.md` 2026-09-04 fix-wave row) — `let closures each see own i: 3,3,3` vs `0,1,2`, nested variant too |
| `iterable-wording` | 21 | 4 | 96 | `v96-seed2000104.js` | `382 - call take#0() throws TypeError: undefined is not iterable (cannot read property Symbol(Symbol.iterator))` / `382 + ... throws TypeError: iterable is not iterable` — root-caused below |
| `map-set-range-v99` | 21 | 9 | 99 | `v99-seed2000298.js` | `map: a:#,b:#,c:#` / `set (dedup): #,#,#` / `custom range: #,#,#,#,#` |
| `arity/arguments-aliasing` | 20 | 3 | **84,94,96,99 (all four)** | `v84-seed2000502.js` | `0 - out print "original"` / `0 + out print "changed-via-arguments"` / `1 out print "declared-arity=3 called-with=1"` |
| `cleanup-push-undefined` | 20 | 2 | 96 | `v96-seed2000129.js` | `6 call cleanup#0() throws TypeError: Cannot read properties of undefined (reading 'push')` / `7 call cleanup#1(undefined) throws same` / `8 call cleanup#2([[1],[2]]) -> [...]` |
| `rest-args-length` | 16 | 10 | 96 | `v96-seed2000061.js` | `0 out print "first=1 rest=[2,3,4] arguments.length=4"` / `1 out print "first=only rest=[] arguments.length=1"` / `2 out print "1,2,3,4,5"` |
| `counter-inc-dec-reset-RangeError` | 13 | 4 | 84,94,99 | `v84-seed2000526.js` | `initial: #` / `inc: #` / `inc: #` (diverges later at `reset:`/`uncaught RangeError`) |
| `globals-dump-mismatch` | 6 | 5 | 96 | `v96-seed2000247.js` | `9 out print "10,20,30"` / `10 out print "14"` / `11 ret undefined` / `12 - globals {...}` |
| *(unclustered residual)* | 65 | 65 | 96,99 | — | heterogeneous singleton value-mismatch traces; not a coherent family, needs a further diff pass — **not** filed as its own BUGS row (see below) |

Total: 460 finds / 349 sigs, exactly matching `reclassify-finds.mjs`'s own
count.

### `iterable-wording`, root-caused

`src/runtime/helpers.ts`'s `__hbc_b_arraySpread` throws a bare
`new TypeError("is not iterable")` with no value description, unlike the
sibling `__hbc_iterBegin` helper a few lines above it, which builds a
V8-style value description (`d`) and produces
`"<description> is not iterable (cannot read property Symbol(Symbol.iterator))"`
— the wording the real Hermes VM actually uses. `__hbc_b_arraySpread` is the
one BUGS row below with a confirmed component/location; the rest are
symptom clusters from this task's sample, not yet individually
investigated to that depth (out of a lean worker's budget for this task).

## Runner status (deb, ~16:15 UTC 2026-09-04)

| campaign | pid | alive | programs so far (cumulative) | pass/div/inc | last log line |
|---|---|---|---|---|---|
| campaign2-v84-2000000 | 458290 | yes | 6,000 | 5,900 / 29 / 71 | `2026-09-04T16:11:17Z v84 chunk 12 seed-base=2006000 count=500` |
| campaign2-v84-3000000 | 458291 | yes | 6,000 | 5,912 / 23 / 65 | `2026-09-04T16:11:05Z v84 chunk 12 seed-base=3006000 count=500` |
| campaign2-v94-2000000 | (exited) | no — target reached | 40,000 | 39,262 / 313 / 425 | `v94: target 40000 reached` / `campaign chunk pass complete (2026-09-04T15:14:11Z)` |
| campaign2-v94-3000000 | (exited) | no — target reached | 40,000 | 39,266 / 294 / 440 | `v94: target 40000 reached` / `campaign chunk pass complete (2026-09-04T15:14:20Z)` |
| campaign2-v96-2000000 | (exited) | no — target reached | 40,000 | 33,061 / 6,448 / 491 | `v96: target 40000 reached` / `campaign chunk pass complete (2026-09-04T14:17:42Z)` |
| campaign2-v96-3000000 | (exited) | no — target reached | 40,000 | 33,292 / 6,214 / 494 | `v96: target 40000 reached` / `campaign chunk pass complete (2026-09-04T14:16:55Z)` |
| campaign2-v99-2000000 | (exited) | no — target reached | 40,000 | 38,570 / 1,071 / 359 | `v99: target 40000 reached` / `campaign chunk pass complete (2026-09-04T15:04:07Z)` |
| campaign2-v99-3000000 | (exited) | no — target reached | 40,000 | 38,546 / 1,038 / 416 | `v99: target 40000 reached` / `campaign chunk pass complete (2026-09-04T15:14:59Z)` |

All counts above are **pre-fix** (deb's live `~/hbc2js` classification, per
the headline finding). v84 is still running toward its 40,000 target at
~500 seeds/33 min (chunk 9→12 took ~100 min for 1,500 seeds) — roughly the
same 2 orders-of-magnitude-slower-than-v94/96/99 pattern the previous
report already flagged, now directly observed live rather than inferred
from an average. `pgrep -f campaign-runner` matches only the 2 remaining
v84 pids; v94/v96/v99's 6 runners completed and exited cleanly (no crash,
no error — genuine `target 40000 reached`).

My own 8 rediff sample jobs (`~/hbc2js-rediff/reports/fuzz/rediff-v*.json`
+ `.log`) are separate from the above and were left running/finished
independently; the 2 v84 ones are still in the background on deb at time of
writing (`~/hbc2js-rediff`, pids `1634301`/`1634302`) and were not waited
out further, per instruction, after ~90 minutes.

## Limitations

- The 2,000-seed-per-version sample (v94/96/99) and the 461-find
  reclassification are **not** a full re-run of the 252,000+ programs the
  live campaigns have produced — a full re-run was judged out of a lean
  worker's compute budget (see "What this task did instead"). The sample is
  seed-range-matched to campaign2's own early range, so version-level rates
  should generalise, but the *count* of distinct signatures almost
  certainly does not (v96 alone has 617 raw divergences in just 4,000
  programs; scaled to its full 80,000-so-far this implies thousands of
  distinct real signatures still open, not the 510 this sample found).
- v84's sample never landed within the bounded wait; its post-fix rate is
  unmeasured. Its pre-fix rate (0.4% divergent, the best of any version) and
  its inclusion in the versionless `arity/arguments-aliasing` family (which
  did reproduce on all 4 versions via the saved finds, independent of the
  incomplete sample) are the only v84 data points here.
- The 65-find "unclustered residual" family is a grab-bag, not a coherent
  root cause, and intentionally has no BUGS.md row of its own (see below) —
  flagged instead as a follow-up needing a deeper diff pass.
- `known-signatures.json` was **not** updated — the tool's own convention
  (`--extract` mode, reading a retriage report's "Surviving signatures"
  section) is for a *retriage* report, and none of the families below have
  been reduced to minimal fixtures yet (that is the normal next step,
  tracked per-row in `docs/BUGS.md`, not this report).
