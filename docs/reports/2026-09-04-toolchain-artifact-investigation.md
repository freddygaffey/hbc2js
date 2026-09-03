# 2026-09-04 — toolchain-artifact investigation across the 191 reclassified divergences

Follow-up to `docs/reports/2026-09-04-async-shared-range-diagnosis.md` (PUSHBACK
P-14), which root-caused one v99 "confirmed decompiler divergence" as a
toolchain artifact: `tests/fixtures/constructs/**` and the construct fuzzer
compile with `tools/hermesc/v99/hermesc` (npm `hermes-compiler@260318099`),
but the D14 trace oracle runs that bytecode under `tools/hermes-vm/v99/bin/hermes`
(source-built, commit `913d31acd10a`) — a different Hermes commit that
disagrees on the async driver's `GetBuiltinClosure` builtin-closure index
(`b58`), so `_makeAsyncIterator` throws in the VM even though the decompiled
candidate is correct. That report's handoff worried this "may be largely" the
explanation for all 191 still-DIVERGENT finds in
`docs/reports/2026-09-03-finds-reclassified.md`. This task quantifies that
across the full campaign rather than one signature.

## Method

`tools/fuzz/toolchain-artifact-probe.mjs` (new, diagnostic-only, not wired
into any gate/CI path) takes each saved find's *original source* (`program`,
as `construct-fuzz.mjs` writes it to `reports/fuzz/finds/v<N>-seed<S>.js`) and:

1. **current harness pairing**: compiles it with `tools/hermesc/v<N>/hermesc`
   (`findHermesc`) and runs the result under `tools/hermes-vm/v<N>/bin/hermes`
   (`findHermesVm`) — this is exactly what `construct-fuzz.mjs` +
   `src/harness/ladder.ts`'s D14 cross-check do today.
2. **matched pairing**: compiles the same source with
   `tools/hermes-vm/v<N>/bin/hermesc` (the VM's own sibling compiler, where it
   exists) and runs *that* under the same `tools/hermes-vm/v<N>/bin/hermes`.

If the two raw VM traces differ, the divergence is toolchain-sensitive (a
candidate artifact); if they're identical, the compiler pairing made no
difference to this program (not attributable to this mechanism — a candidate
for real triage, though it may still turn out to be some other harness
limitation, e.g. a documented Node-vs-Hermes semantic gap).

A structural fact came out of reading `src/harness/hermes-vm.ts` before
running anything, and changed the sampling plan: **`findHermesVm` only ever
resolves to a *different* binary than `findHermesc` for v94 and v99.** Its
discovery order is `tools/hermes-vm/v<N>/bin/hermes` first, then
`tools/hermesc/v<N>/hermes` as a fallback. Only v94 and v99 have a
`tools/hermes-vm/v<N>/` directory at all (source-built, per
`tools/build-hermes-vm.sh`); v84, v96 and v98 do not, so `findHermesVm`
falls back to the `hermes` binary sitting right next to the very
`tools/hermesc/v<N>/hermesc` that compiled the fixture — **the same npm
package/commit**, confirmed directly (`ls tools/hermesc/v84`,
`tools/hermesc/v96` both contain sibling `hermesc`+`hermes`; v98 has neither
a `tools/hermes-vm/v98/` dir nor a `tools/hermesc/v98/hermes`, so
`findHermesVm(98)` returns `null` entirely and v98's one find never used a
VM trace oracle — it was a `roundtrip` divergence, not `trace`). So for
v84/v96/v98, compile and run are *always* self-consistent by construction —
this specific artifact class is structurally impossible there, not merely
untested. The probe was still run against sampled v84/v96 finds to confirm
this empirically (`sameBinaryTree=true` printed for all of them; see below).

Given that, the useful population to sample exhaustively is v94 (46 finds
on disk) and v99 (59 finds on disk) — small enough to just run all of them
rather than a 5-per-version sample.

## Results

| version | finds on disk | VM-mismatch structurally possible? | DIFFERS (toolchain-sensitive) | IDENTICAL (not this mechanism) |
|---|---|---|---|---|
| v84 | 50 | no (same binary compiles+runs) | n/a | n/a — 3 sampled, all `sameBinaryTree=true` |
| v94 | 46 | yes | 1 (see caveat below) | 45 |
| v96 | 42¹ | no (same binary compiles+runs) | n/a | n/a — 3 sampled, all `sameBinaryTree=true` |
| v98 | 1 | no VM at all (`findHermesVm(98) === null`) | n/a | n/a — out of scope, roundtrip not trace oracle |
| v99 | 59 | yes | 42 | 17 |

¹ `docs/reports/2026-09-03-finds-reclassified.md`'s table lists 45 finds on
disk for v96 with 42 still DIVERGENT; the discrepancy (3) is pre-existing in
that report and not investigated further here — irrelevant to this task
since the mechanism cannot apply to v96 either way.

v94 and v99 were run **exhaustively** (all files on disk), not sampled; v84
and v96 were spot-checked (3 each) purely to confirm `sameBinaryTree=true`
holds, which it does for every file checked.

### v99: 42/59 (71%) toolchain-sensitive, and it's the same known bug

Of the 42 v99 "DIFFERS" cases, 41 show the identical
`Uncaught TypeError: undefined is not a function` /
`at _makeAsyncIterator (address at InternalBytecode.js:1:27113)` crash under
the mismatched pairing that vanishes under the matched one (the 42nd,
`v99-seed777090.js`, shows the same `Uncaught TypeError: undefined is not a
function` on its own first-6-lines slice; the `_makeAsyncIterator` frame is
simply past that slice — same signature, confirmed by inspection). This is
**exactly** the P-14 bug, reproduced at scale: any v99 program touching
`async function`/`for await`/similar built-in-closure machinery crashes
under `tools/hermesc/v99` + `tools/hermes-vm/v99`'s mismatched pairing, and
runs clean under the VM's own matched compiler.

Cross-checked (not just VM-vs-VM, but against the actual decompiled
candidate) for three samples (`v99-seed777007.js`, `-777295.js`,
`-777844.js`): decompiled the mismatched-compiled bytecode, ran the
candidate under Node with a `print` shim, and confirmed the candidate's
output is **byte-identical** to the matched-pairing VM run in each case —
i.e. the decompiler was already correct; the mismatched VM run is what was
wrong. Example (`v99-seed777007.js`):

```
mismatched VM run:  guarded ok: 5 / guarded throw: null / seen: reportError boom /
                     inGuard settled at: 0 / Uncaught TypeError: undefined is not
                     a function at _makeAsyncIterator (...)
matched VM run:      guarded ok: 5 / guarded throw: null / seen: reportError boom /
                     inGuard settled at: 0 / nested: outer caught rethrown inner /
                     await no-throw: async-ok
candidate (Node):    guarded ok: 5 / guarded throw: null / seen: reportError boom /
                     inGuard settled at: 0 / nested: outer caught rethrown inner /
                     await no-throw: async-ok / await throw: async-caught async-boom /
                     final seen: ...
```

The 17 v99 "IDENTICAL" cases (e.g. `v99-seed777578.js`, `-778046.js`) are
unaffected by the compiler swap — they're the genuine candidates for real
triage (spread/object literal, try/finally, non-async control flow; none of
the sampled ones touch `async`).

### v94: effectively 0/46 — this bug does not reproduce there

Only one v94 file (`v94-seed782510.js`) showed any difference between
pairings, and its first six output lines are identical between the two runs
— the difference is only in later lines under a 5s timeout on a `tick`-style
interval-driven program, i.e. consistent with real-time scheduling jitter
between two separate subprocess runs rather than a compiler-caused semantic
difference (both runs hit `ok=false`/timeout; the VM never got a clean exit
on either side to compare against). No async-builtin-closure crash pattern
appears anywhere in the v94 log. **This says the v99 async/`GetBuiltinClosure`
commit drift is v99-specific** (Static Hermes-era bytecode/builtin layout),
not a general property of "any version with a source-built VM" — v94's
`tools/hermesc/v94/hermesc` and `tools/hermes-vm/v94/bin/hermesc`, despite
being different binaries, evidently agree closely enough on builtin-closure
indices that none of the 46 saved finds notice the difference.

### v84/v96/v98: 93 finds, out of scope for this mechanism entirely

These 93 finds (50 + 42 + 1, using the reclassified-report's DIVERGENT
counts) cannot be toolchain-mismatch artifacts of this kind, because there
is no second toolchain in the picture for them — compile and run already
share one binary tree (v84/v96) or there is no VM at all (v98, `roundtrip`
oracle only). This is a genuine **harness gap** in a different sense than
"we lack a matched compiler to test with": there is no commit-mismatch
mechanism *to* test for at these versions. Whatever is producing these 93
divergences, it is not this bug — it could be genuine decompiler defects,
Node-vs-Hermes semantic drift unrelated to compiler version (the class
`docs/BUGS.md`'s 2026-09-02 row already documents for `arguments`-aliasing,
TDZ-with-shadowing, `switch(-0)`, etc.), or fuzzer artifacts (resource
exhaustion — one v96 sample hit `LLVM ERROR: OOM: ... Max heap size was
exceeded`, clearly not a decompiler bug at all). None of that was
triaged further here; it is out of this task's scope.

## Tally against the 191

| bucket | count | fraction of 191 |
|---|---|---|
| v99, confirmed toolchain artifact (this bug) | 42 | ~22% |
| v99, genuine/candidate (unaffected by compiler swap) | 17 | ~9% |
| v94, effectively unaffected by compiler swap | ~39² | ~20% |
| v84 + v96 + v98, mechanism structurally inapplicable | 93 | ~49% |

² using the reclassified-report's 39 still-DIVERGENT count for v94 rather
than the 46 files on disk the probe actually ran against (which include a
few already-reclassified PASSes); the probe's 1/46 rate would round to 0-1
either way.

**Conclusion: roughly 42 of the 191 (~22%) are plausibly explained by this
specific toolchain-mismatch mechanism, and every one of those 42 is v99 and
async-shaped.** This is a real, sizeable, and previously-invisible harness
defect — but it is *not* the general explanation for the campaign's
divergences that the prior report's "BIG IMPLICATION" note flagged as a
risk. The other 149 (v94's ~39, plus all of v84/v96/v98's 93, plus v99's own
17 non-async survivors) need ordinary per-signature triage; only the v99
async-crash class should be presumed toolchain noise pending the P-14 fix.

## Recommended fix: harness change, not 42 decompiler fixes

The 42 v99 cases should not be fixed by touching the decompiler at all — the
decompiler is already correct on all three cross-checked samples. The
correct fix is confined to the D14 trace-oracle's reference side, in
`src/harness/ladder.ts` around lines 183-227 (`opts.reference.engine ===
"hermes-vm"` branch): today it writes `opts.hbcBytes` (compiled by whichever
`hermesc` the *caller* used — always `tools/hermesc/v<N>` for both the
construct fuzzer and the gate fixture builder) to a temp file and runs that
under `opts.reference.vm.path`.

**Precise change**: when `opts.reference.vm.path` resolves to a source-built
VM (`tools/hermes-vm/v<N>/bin/hermes`, as opposed to the
`tools/hermesc/v<N>/hermes` fallback) *and* `opts.sourceJsPath` is available
(true for every fuzz-generated program and every construct fixture with a
`source.js` — false only for real-bundle differential testing, where there
is no separate source to recompile), recompile `opts.sourceJsPath`'s content
with that VM's own sibling `tools/hermes-vm/v<N>/bin/hermesc` and run *that*
bytecode as the reference, instead of `opts.hbcBytes`. Leave
`opts.candidateJsPath`/`ta`/`candidatePrint` untouched — the decompiled
candidate keeps being derived from the real (`tools/hermesc`-compiled)
bytecode, since that's what an actual RN bundle's decompiler input looks
like; only the "what should this program's own output truly be" oracle side
needs the matched compiler. Guard it so a version with no
`tools/hermes-vm/v<N>/bin/hermesc` sibling (i.e. `hermesc` missing next to
an existing `hermes`, which doesn't currently happen but isn't guaranteed by
`findHermesVm`'s contract) falls back to current behaviour with a caveat,
mirroring `VM_LIMITATIONS`'s existing "the VM is confirmed incomplete"
caveat style.

This is a single, scoped, testable change (one new code path in
`runOracleLadder`'s D14 branch, one regression test compiling the same
minimal async construct at v99 and asserting the override fires and the
verdict is PASS-with-caveat, one test confirming the real-bundle path
— no `sourceJsPath` — is unaffected). It supersedes the P-14-blocked
`VM_LIMITATIONS` entries (the 5 existing v99 rows plus adversarial-43)
with a general mechanism rather than curated per-fixture rows, and would
retroactively re-triage all 42 of the toolchain-sensitive finds identified
here without touching the decompiler. **Not implemented this pass** per the
task brief — it changes `ladder-d14-override.test.ts`'s hard assertions
(same blocker P-14 already identified) and needs a review before landing.

## Artifacts

- `tools/fuzz/toolchain-artifact-probe.mjs` — the probe script used above
  (diagnostic-only; not wired into any gate/CI path). Usage:
  `node tools/fuzz/toolchain-artifact-probe.mjs v99-seed777007.js ...`
  (reads from `reports/fuzz/finds/`, prints both pairings' raw VM output per
  named file).
- Raw logs from the exhaustive v94/v99 runs were not committed (regenerable
  in ~15-90s via the probe script against `reports/fuzz/finds/` — the finds
  directory itself is gitignored, per `tools/fuzz/construct-fuzz.mjs`'s own
  comment).

## What this does *not* establish

- Whether the 17 v99 non-async survivors, the ~39 v94 survivors, or the 93
  v84/v96/v98 survivors are genuine decompiler bugs, other Node-vs-Hermes
  semantic drift, or fuzzer/resource artifacts — that per-signature triage
  is unstarted.
- Whether v94's `tools/hermesc/v94/hermesc` and
  `tools/hermes-vm/v94/bin/hermesc` truly share a commit, or merely happen
  to agree on builtin-closure indices for the 46 programs sampled here —
  no version banister with a commit hash was available from either binary
  (`--version` prints only `LLVH 8.0.0svn Optimized build` for every
  version tested, no git SHA) to confirm directly.
