# v96 Hermes VM build + campaign-2 v96 re-diff, take 2 — 2026-09-05

Corrects `docs/reports/2026-09-05-campaign2-rediff.md`: every v96 cell in that
report claims `mode: "full-ladder"` (VM-cross-check), but deb's
`~/hbc2js/tools/hermesc/v96/` never had a `hermes` interpreter, only
`hermesc` — `chooseReference()` silently fell back to `expected-txt`
(Node-captured) for every v96 run there. This task built a real v96 VM on
deb, re-ran the v96 sample and the saved v96 finds against it, and confirms:
**all 400 saved v96 finds and all four family clusters attributed to v96 in
the old report are Node-vs-old-Hermes semantic differences (D14), not
decompiler bugs.** Zero genuine v96 divergences survive in this sample.

Lean worker, compute on `deb` per the brief. Repo `~/hbc2js-rediff`
(deb's own re-diff clone; `~/hbc2js`, the live campaign-runner clone, was
never touched, per the brief).

## 1. VM build

`tools/build-hermes-vm.sh` extended to accept `96` (previously `94|99` only),
pinned at `644c8be78af1eae7c138fa4093fb87f0f4f8db85` — the exact commit
`react-native@0.73.11`'s `package/sdks/.hermesversion` records (recorded,
with the same no-guessing derivation as v94, in `docs/AGENT-LOG.md`'s
2026-08-30 "v96 toolchain" row when v96 was added to `tools/get-hermesc.sh`).
Same classic-Hermes `main` lineage as 94 (the `static_h` fork happens at
v97), so the v94 build path — including the CMake ≥4.0 `CMP0026`-OLD compat
patch — applies verbatim; extended that patch's version guard from
`"94"` to `"94"` or `"96"` rather than duplicating it. `tests/support/hermesvm.ts`'s
`CANDIDATES` list (the one place a test enumerates supported versions) got a
`96 -> tools/hermes-vm/v96/bin/hermes` entry alongside 94/99.
`docs/TOOLCHAIN.md`'s VM table, commit-selection table and build-notes
prose updated to match; `docs/fuzz/CONSTRUCT-FUZZER.md` and
`tools/fuzz/diff-signatures.mjs`'s schema comment document the new
`referenceEngine`/`mode: "full-ladder-no-vm"` fields (§4 below).

Sync to deb: `~/hbc2js-rediff`'s `origin` (`/home/fred/hbc2js`) was stale at
`59beb64`; GitHub was reachable from deb, so `git fetch
https://github.com/freddygaffey/hbc2js.git main` got to `8c0507c` directly,
then a `git bundle` of this task's own local Mac commit (`23b4996`, the
build-script change above, not yet pushed) supplied the rest — `git fetch
~/hbc2js-main.bundle main:mac-main && git checkout -B rediff-v96 mac-main`.
`~/hbc2js-rediff/tools/hermes-vm` was a **symlink into `~/hbc2js`**
(gitignored, pre-existing from a prior task); replaced with a real directory
so v96's build (per the brief: "a real directory there, not a symlink into
`~/hbc2js`") couldn't write through it into the read-only campaign-runner
clone. This incidentally cut off the pre-existing v94/v99 symlinked access;
restored it by symlinking `tools/hermes-vm/{v94,v99}` individually back to
`~/hbc2js/tools/hermes-vm/{v94,v99}` (read-only use, same convention the
brief allows for `tools/hermesc`), leaving `tools/hermes-vm/v96` as the one
real, locally-built directory.

Build: `nice -n 10 tools/build-hermes-vm.sh 96` (`HERMES_BUILD_JOBS=24`, i.e.
`ninja -j24`, per the brief's cap). **~32 seconds wall-clock** end to end on
deb's 32 cores — blob-filtered clone of facebook/hermes started
02:42:30, binaries written 02:43:02 (`hermes`, `hermesc`, `hbcdump`; 319 C++
translation units for the `hermes`/`hermesc`/`hbcdump` target set, not the
full Hermes test suite/LLVM — same reduced scope the script documents for
94/99). `tools/hermes-vm/v96/bin/hermes -version` reports `HBC bytecode
version: 96`.

### Verification (both byte-for-byte, per the brief)

```
$ tools/hermesc/v96/hermesc -emit-binary -out=v96-seed2000000.hbc reports/fuzz/finds/v96-seed2000000.js
$ tools/hermes-vm/v96/bin/hermes -b v96-seed2000000.hbc
undefined
after declaration: now-initialized
outer
inner val: shadowed val2: inner-shadow
outer val unchanged: shadowed
```
— matches the brief's cited output exactly.

```
$ echo "function take(){ var x; try { var a=[...x]; } catch(e){ print(e.message) } } take();" > take.js
$ tools/hermesc/v96/hermesc -emit-binary -out=take.hbc take.js
$ tools/hermes-vm/v96/bin/hermes -b take.hbc
Cannot convert undefined value to object
```
— matches the brief's cited output exactly (same message the v99 VM gives;
Node says "undefined is not iterable").

Both match; did not need to "fix" anything.

## 2. Corrected v96 numbers

### 2.1 Fresh 2×2,000-seed sample (`construct-fuzz.mjs --versions 96`, same
seed bases as the original report: 2000000, 3000000), 8-way parallel, `nice
-n 10`, 250 seeds/chunk

Every one of the 16 chunks reports `"mode": "full-ladder", "referenceEngine":
"hermes-vm"` (confirmed from the JSON, not just the console banner) — the
harness fix from §4 makes this an assertion, not an assumption, going
forward.

| seed base | chunk | n | pass | divergent | inconclusive |
|---|---|---|---|---|---|
| 2000000 | 0 | 250 | 246 | 0 | 4 |
| 2000000 | 1 | 250 | 245 | 0 | 5 |
| 2000000 | 2 | 250 | 246 | 0 | 4 |
| 2000000 | 3 | 250 | 243 | 0 | 7 |
| 2000000 | 4 | 250 | 246 | 0 | 4 |
| 2000000 | 5 | 250 | 243 | 0 | 7 |
| 2000000 | 6 | 250 | 244 | 0 | 6 |
| 2000000 | 7 | 250 | 242 | 0 | 8 |
| 3000000 | 0 | 250 | 243 | 0 | 7 |
| 3000000 | 1 | 250 | 244 | 0 | 6 |
| 3000000 | 2 | 250 | 245 | 0 | 5 |
| 3000000 | 3 | 250 | 245 | 0 | 5 |
| 3000000 | 4 | 250 | 247 | 0 | 3 |
| 3000000 | 5 | 250 | 244 | 0 | 6 |
| 3000000 | 6 | 250 | 249 | 0 | 1 |
| 3000000 | 7 | 250 | 241 | 0 | 9 |
| **total** | | **4,000** | **3,913** | **0** | **87** |

| | pre-VM (old report, `expected-txt`/Node reference, mislabelled `full-ladder`) | with-VM (this task, `hermes-vm` reference, real `full-ladder`) |
|---|---|---|
| programs | 4,000 | 4,000 |
| pass | 3,310 (82.8%) | 3,913 (97.8%) |
| divergent | 617 (15.4%) | **0 (0%)** |
| inconclusive | 73 (1.8%) | 87 (2.2%) |

**All 617 of the old report's raw v96 divergences were Node-vs-old-Hermes
artefacts.** The 87 INCONCLUSIVE (up from 73) are `ladder-budget-prefix`
resource-ceiling truncations (P-16, `b5362b0`: "a budget cut-off is
INCONCLUSIVE, never DIVERGENT") — the real VM's execution is slower/heavier
under concurrent load on deb (six other campaign runners were active on the
same box at the time; see `docs/AGENT-BRIEF.md`'s noted
`ladder-budget-prefix.test.ts` load flake) than the previously-used
`expected-txt` comparison, so more runs hit the wall-clock/output-size
ceiling before reaching a verdict — never a divergence, always "cannot yet
tell", exactly as intended.

### 2.2 Reclassification of the 400 saved v96 finds (`reclassify-finds.mjs`)

Confirmed via the tool's own banner: `v96: reference engine = hermes-vm —
Hermes VM v96 is available; per D14 its own trace of the fixture's .hbc is
the reference`.

| version | reference engine | total | now PASS | still DIVERGENT | still ERROR |
|---|---|---|---|---|---|
| v96 | hermes-vm | 400 | **397** | **0** | 0 |

The 3 non-PASS are INCONCLUSIVE, not DIVERGENT, all the same
`ladder-budget-prefix` shape (`resource: the candidate hit an engine
resource ceiling while the VM kept running` / `the candidate-vs-source.js
divergence is refuted by the Hermes VM inside the observed prefix (D14);
Hermes VM cross-check truncated by a budget after …`):
`v96-seed2000502.js`, `v96-seed2001030.js`, `v96-seed3001133.js`. None of
these coincide with any family's example seed below — every named family
exemplar is a clean PASS.

Cross-check: `v94`/`v99` also reclassify cleanly with their VMs restored
(`~/hbc2js-rediff/tools/hermes-vm/{v94,v99}` — see §1's symlink note); v99
still shows 29 genuine DIVERGENT (the `map-set-range-v99` family, out of
scope for this task — v99 already had a working VM in the original report,
so this number is not a correction, just confirmation the harness still
works for it) and v84 shows all-INCONCLUSIVE for its 3 saved finds under
system load (also out of scope; v84 always had a VM). Full table in
`reports/fuzz/reclassify-v96-vm.md` (gitignored, not committed; brought back
locally at that path).

## 3. Corrected family table

Every v96-attributed family from the old report's table (`docs/reports/2026-09-05-campaign2-rediff.md`
§"Families") is now confirmed a D14 artefact — **not one of the 400 v96
finds is DIVERGENT under the real VM**, and every family's own cited
example seed reclassifies to PASS individually (verified directly, not just
by inference from the aggregate 0/400):

| family | v96 finds (old report) | example seed | with-VM verdict |
|---|---|---|---|
| `TDZ/ReferenceError-value` | 158 | `v96-seed2000000.js` | **PASS** (this is the brief's own byte-for-byte-verified exemplar, §1) |
| `unexpected-ReferenceError-missing-global` | 61 | `v96-seed2000012.js` | **PASS** |
| `other-cannot-read-props` | 38 | `v96-seed2000034.js` | **PASS** |
| `iterable-wording` | 21 | `v96-seed2000104.js` | **PASS**, directly re-verified in this task against the *current, still-unfixed* `src/runtime/helpers.ts` on deb (a concurrent agent's `__hbc_notIterable` fix, `docs/BUGS.md`'s row 112, has not landed on `main` yet) — this specific find does not exercise the wording bug that row independently root-caused; consistent with, not contradicting, that row |
| `cleanup-push-undefined` | 20 | `v96-seed2000129.js` | **PASS** |
| `rest-args-length` | 16 | `v96-seed2000061.js` | **PASS** |
| `globals-dump-mismatch` | 6 | `v96-seed2000247.js` | **PASS** |
| `let-closures-capture` (v96 slice; also 99) | ~part of 21 | `v96-seed2000016.js` | **PASS** |
| `arity/arguments-aliasing` (v96 slice; also 84,94,99) | ~part of 20 | — | v96 slice PASS (0/400 aggregate); **84/94/99 members untouched by this task, not re-verified** |
| unclustered residual (v96 slice; also 99) | ~part of 65 | — | v96 slice PASS (0/400 aggregate); v99 slice untouched |

`map-set-range-v99` (21 finds, v99-only) and `counter-inc-dec-reset-RangeError`
(13 finds, 84/94/99, not 96) have no v96 members and are entirely unaffected
by this task — still open, still unverified either way.

## 4. Harness stops hiding this

`tools/fuzz/reference-mode.mjs` (new): `modeForCell(isTracedVersion,
referenceEngine)` — a traced version's cell can only report `mode:
"full-ladder"` when `referenceEngine === "hermes-vm"`; any other engine
(`"expected-txt"`, `"node-source"`) on a traced version now reports `mode:
"full-ladder-no-vm"` instead — same oracle set (`syntax`, `trace`, `fuzz`),
but the reference was Node/expected.txt, so pass/divergent counts are **not**
a VM-cross-check and must not be read as one (exactly the mislabelling this
whole task corrects). `referenceEngineBanner(version, reference)` prints one
loud, greppable line per version at campaign/reclassify start, e.g.:

```
v96: reference engine = expected-txt (no Hermes VM found) — no Hermes VM for v96; ...
```

Wired into both `tools/fuzz/construct-fuzz.mjs` and
`tools/fuzz/reclassify-finds.mjs`; each cell/row now also records
`referenceEngine`. `tools/fuzz/diff-signatures.mjs` treats `mode` as an
opaque label (aggregated into a `Set`, displayed verbatim), so the new
label needed no change there beyond a documentation comment.
`tests/gate/tools/fuzz-reference-mode.test.ts` (new, cheap — no VM/hermesc
needed): unit-tests `modeForCell`/`referenceEngineBanner` against stubbed
`ReferenceChoice`-shaped inputs, plus one integration check against the real
`chooseReference` for v98 (a version this repo never ships a VM for, so
deterministic on every host).

## 5. Proposed `docs/BUGS.md` row moves (not applied — `docs/BUGS.md` is owned by another agent right now)

The ten `2026-09-05 | campaign-2 rediff` rows the brief named are actually
**nine still-`open`** (lines 53–61 at the time of writing) plus **one
already independently moved to `fixed`** by a concurrent agent
(`iterable-wording`, line 112) — its own conclusion (PASS after a runtime
wording fix) is consistent with, not contradicted by, this task's
finding that the same example seed also passes *without* that fix, per
§3's note.

Proposed moves for the nine open rows:

| row (family) | proposal | basis |
|---|---|---|
| `TDZ/ReferenceError-value` | **Resolved, `d14-legit`** | 0/400 v96 finds DIVERGENT under the real VM; example seed re-verified individually (§1, byte-for-byte match to the brief's cited output) |
| `unexpected-ReferenceError-missing-global` | **Resolved, `d14-legit`** | same evidence; example seed re-verified individually |
| `other-cannot-read-props` | **Resolved, `d14-legit`** | same evidence |
| `cleanup-push-undefined` | **Resolved, `d14-legit`** | same evidence |
| `rest-args-length` | **Resolved, `d14-legit`** | same evidence |
| `globals-dump-mismatch` | **Resolved, `d14-legit`** | same evidence |
| `arity/arguments-aliasing` | **Stay open, but narrow scope to `84,94,99`** (drop 96) | v96 members are confirmed D14-legit (0/400 aggregate), but this family's 84/94/99 members were not touched by this task and may still be a real decompiler bug there |
| `map-set-range-v99` | **Stay open, unchanged** | no v96 members; entirely untouched by this task |
| `counter-inc-dec-reset-RangeError` | **Stay open, unchanged** | no v96 members; entirely untouched by this task |

## 6. Not done / left for the orchestrator

- The 87/4,000 (2.2%) INCONCLUSIVE rate under load is worth a follow-up once
  deb is quieter, to confirm it settles back near the old 1.8% baseline
  rather than being a genuine harness regression — not investigated further
  here (out of this task's scope, and explicitly a known/expected shape per
  P-16).
- `arity/arguments-aliasing`'s 84/94/99 members and the residual/`let-closures-capture`
  v99 slices were not re-verified (no v99/84/94 VM work was in scope here);
  the family table above already flags exactly which slices that leaves
  open.
- `docs/BUGS.md` itself: not edited, per the brief; §5's table is the
  proposal for whoever owns it next.

## Correction to the original report

`docs/reports/2026-09-05-campaign2-rediff.md` has a "Correction" section
prepended pointing here.

