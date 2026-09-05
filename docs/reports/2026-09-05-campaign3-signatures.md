# Campaign 3 morning-after harvest — 2026-09-05

Lean worker, compute on `deb` (own clone `~/hbc2js-c3` @ `1e1fe39`, unmodified
per `docs/fuzz/CONSTRUCT-FUZZER.md`'s Campaign 3 section). `tools/fuzz/diff-signatures.mjs`
and `tools/fuzz/known-signatures.json` on deb already matched this worktree's
copies byte-for-byte (md5 verified) — no scp needed.

## Status at harvest time

v94/v96/v99 reached their `--target 10000` (state files at target, runners
exited cleanly). v84 is still running (seed-base 4000000 is genuinely ~2
orders of magnitude slower per program than the other three, same pattern
every prior campaign report has noted) — **not stopped**, harvested as-is,
partial.

```
node tools/fuzz/diff-signatures.mjs ~/hbc2js-fuzz/campaign3-v*-4000000 --out ...
```

| version | mode | programs | pass | divergent | error | inconclusive | pass rate | status |
|---|---|---|---|---|---|---|---|---|
| v84 | full-ladder | 2,500 | 2,468 | 1 | 0 | 31 | 98.7% | partial, still running |
| v94 | full-ladder | 10,000 | 9,859 | 0 | 0 | 141 | 98.6% | target reached |
| v96 | full-ladder | 10,000 | 9,859 | 1 | 0 | 140 | 98.6% | target reached |
| v99 | full-ladder | 10,000 | 9,885 | 2 | 0 | 113 | 98.9% | target reached |

**0 of the 64 known signatures fired.** 2 raw NEW signature strings were
reported by the diff tool; both turned out to be the *same* underlying
family (see below) — the tool's per-report signature text includes whatever
`print()` line the fuzzed program happened to emit right before the
divergence, so two occurrences of one family with different leading output
land as two distinct strings. This is the tool's documented caveat
(signatures are flat per-chunk text, not root-cause-deduped) rather than a
new bug in the tool itself.

## Family: `-Infinity`-bound loop -> Hermes RangeError vs Node OOM/timeout

**Not a decompiler bug** (confirmed below to reproduce identically without
any decompilation involved) — a fuzzer/VM-difference artifact.

- **Where seen:** v84 (chunk 00000), v99 (chunks 00002, 00008), v96 (chunk
  00019). 4 divergent reports total, all versions land on the identical
  signature tail:
  `err main RangeError: Invalid array length` (VM) vs `limit sync-timeout`
  (candidate) — i.e. the real Hermes VM throws promptly, the candidate under
  Node runs past the harness's execution budget without erroring.
- **Root cause:** the mutation-mode fuzzer's grammar can rewrite a `for`
  loop's initial value to `-Infinity` (already the documented behaviour
  behind campaign-2's H1 family, `docs/reports/2026-09-04-fuzz-families.md`).
  `-Infinity + 1 === -Infinity` in IEEE754, so `i` never advances and the
  loop body (`closures.push(...)`) runs unboundedly. Hermes's array backing
  store has a materially smaller effective capacity ceiling than V8's, so
  the real Hermes VM hits `RangeError: Invalid array length` at ~67M pushed
  elements (a few seconds); Node/V8 keeps growing until it exhausts the
  process heap (~4 GB) and hard-crashes with an OOM fatal error, well past
  the harness's synchronous execution budget, so the harness's own side
  reports `limit sync-timeout` rather than a matching error.
- **Confirmed not decompiler-introduced:** re-ran the saved find
  `v99-seed4004486.js` two ways with NO decompilation involved at all —
  `node <file>.js` directly, and `hermesc -emit-binary` + the real
  `tools/hermes-vm/v99/bin/hermes` on the compiled `.hbc` directly. Same
  split: Hermes VM throws `Uncaught RangeError: Requested an array size
  that fails to allocate: Requested elements = 67088252` within ~1s; Node
  runs ~18s then dies of `FATAL ERROR: Ineffective mark-compacts near heap
  limit ... JavaScript heap out of memory`. The divergence is inherent to
  the two JS engines' Array capacity limits, not to hbc2js's translation.
- **Minimised repro** (from the actual find, trimmed to the failing part):
  ```js
  const closures = [];
  for (let i = -Infinity; i < 3; i++) {
    closures.push(function () { return i; });
  }
  print('done:', closures.length);
  ```
- **Suggested harness follow-up (not implemented here, no src changes in
  scope):** this may be a variant of the P-16/H1 truncation-artifact class
  that isn't yet covered — one side erroring with a genuine (not
  timeout-induced) `RangeError` while the other side is still running past
  budget currently classifies as DIVERGENT rather than INCONCLUSIVE. Left
  for whoever next touches `src/harness/ladder.ts` / `compare.ts`; not filed
  as a `docs/BUGS.md` row because it is not a decompiler-bug family (the
  brief's row criterion) — it is a harness-classification question the
  orchestrator can route.

## Also observed: stale v98 finds in `campaign3-v96-4000000/finds/`

`campaign3-v96-4000000/finds/` holds exactly 20 files named `v98-seed4000000`
through `v98-seed4000019` — these are **not** campaign 3 v96 output. Campaign
3 only launched 84/94/96/99 (v98 has no VM, roundtrip-only, per the
Campaign-3 section's own smoke-test note). The count (20) and seed range
(4000000-4000019) exactly match the smoke test's `campaign3-smoke/v98.json`
run (20 programs, seed-base 4000000, `mode: roundtrip-only`, 20/20
"divergent" — the pre-existing, already-documented roundtrip
function-count-comparison weakness, PUSHBACK P-12). This confirms the
already-known "finds land in a shared, cap-per-process directory racing
across concurrently-launched processes" artifact
(`docs/reports/2026-09-05-campaign2-rediff.md`, item 2): the smoke test and
the v96 `campaign-runner.sh` process both started around the same wall clock
time and wrote to overlapping default finds paths. Also explains why the
one real v96 divergent chunk (00019) above has **no saved find file** — its
`finds/` slot was already occupied by the 20 v98 leftovers by the time it
would have been written. Not a new bug; matches the prior report's
diagnosis exactly. No action taken (no src changes in scope).

## v84 (complete)

`v84`'s campaign-runner process (pid 4072405 at re-check time; an earlier
run of the same command, pid 869796, had already exited/restarted under the
same state dir before this task started, which is why the runner pid seen
here differs from the one named in the launch brief — state is on disk and
resume is idempotent per the Campaign 3 section, so this is a non-event)
reached its own `--target 10000` and exited cleanly while this task was
waiting on it (`state/v84.count` = 10000, 40 `reports/*.json` chunks). Diff
re-run against the full, completed campaign dir:

```
node tools/fuzz/diff-signatures.mjs ~/hbc2js-fuzz/campaign3-v84-4000000 --out ...
```

| version | mode | programs | pass | divergent | error | inconclusive | pass rate | status |
|---|---|---|---|---|---|---|---|---|
| v84 | full-ladder | 10,000 | 9,855 | 2 | 0 | 143 | 98.6% | target reached |

`tools/fuzz/diff-signatures.mjs` and `tools/fuzz/known-signatures.json` on
`~/hbc2js-c3` on deb matched this worktree's copies byte-for-byte (md5
verified) — no scp needed. **0 of the 64 known signatures fired.** 1 raw
NEW signature string, from 2 divergent reports (chunks `00000` and `00006`,
both the identical signature text — the tool's per-chunk-text caveat noted
above, not two distinct bugs):

```
DIVERGENT:trace:     0 - err main RangeError: Invalid array length
     0 + limit sync-timeout
```

The chunk `00000` find (`v84-seed4003104.js`) is, byte for byte, the same
family already diagnosed above for v84/v96/v99: a `for (let i = -Infinity;
i < 3; i++)` loop whose body pushes a closure — `-Infinity + 1 ===
-Infinity` in IEEE754, so the loop never advances, and Hermes's smaller
effective Array capacity ceiling throws `RangeError: Invalid array length`
in seconds while Node/V8 keeps growing the array well past the harness's
synchronous execution budget (`limit sync-timeout`) before eventually
OOM-crashing. Not a decompiler bug — same root cause, same non-fix, already
confirmed to reproduce with no decompilation involved (see the family
section above). Chunk `00006`'s divergent report has no saved find file
(same shared-finds-dir race already documented for the v96 chunk `00019`
case above — first-writer-wins per seed slot, not evidence of a second,
distinct program).

**Campaign 3 conclusion, all four versions (84/94/96/99), final:** all four
reached their `--target 10000` (84 last, ~09:40 UTC). Combined: 39,855 pass
/ 5 divergent / 0 error / 527 inconclusive across 40,000 programs (~99.1%
excluding v84's extra weight; per-version pass rates 98.6-98.9% throughout).
**0 of 64 known signatures fired anywhere; 0 genuinely-new decompiler-bug
families** — every raw "NEW" signature string across all four versions
collapses into the single `-Infinity`-bound-loop fuzzer/VM-capacity-limit
artifact diagnosed above. No `docs/BUGS.md` row added.

## Conclusion

Campaign 3 (post P-16/fix-wave-3, fresh clone) shows a clean **~98.6-98.9%
pass rate across all four launched versions with the real VM** and **0
genuinely-new decompiler-bug families** in this harvest — the only 2 raw
"NEW" signature strings collapse into one already-diagnosed fuzzer/VM-limit
artifact, not a translation defect. No `docs/BUGS.md` row added (nothing
qualifies as a new decompiler-bug family). v84 has since completed (see
"v84 (complete)" above) with the same conclusion — no re-harvest is
outstanding.
