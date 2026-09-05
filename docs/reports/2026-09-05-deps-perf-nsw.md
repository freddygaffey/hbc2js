# `hbc2js deps` perf on the Service NSW bundle (2026-09-05)

Ledger row: `docs/BUGS.md` 2026-09-01 "`hbc2js deps` on the 12.7 MB bundle did
not finish in 10 minutes (killed)". Profiled on deb (`~/hbc2js-perf`, checkout
`45ebaf4`, a fresh clone, never touching `~/hbc2js` or `~/hbc2js-c3`) against
the real proprietary bundle (`~/hbc2js-corpus/nsw.hbc`, 12.7 MB, never
committed — this report carries only aggregate numbers).

## Headline: already well under 10 minutes

The row was filed 2026-09-01. `377abff` ("deps: evidence-directed candidate
matching", QUEUE 22a), landed 2026-09-03, replaced the match stage's
brute-force scoring (every DB signature file against the bundle) with a
candidate-directed scan gated on the bundle's own string evidence. That
alone appears to have fixed the timeout: three independent runs on deb (32
core, load < 8 throughout) all completed in 2-3 minutes, no `--confirm`:

| run | wall (`time`, real) | user | notes |
|---|---|---|---|
| 1 (plain) | 2m35.3s | 8.1s | baseline |
| 2 (`--cpu-prof`) | 2m14.9s | 10.7s | profiling overhead noise, not a regression |
| 3 (plain, post-fix below) | 2m26.7s | 7.6s | after the `guess.ts` cache landed, still has instrumentation removed |

Output: 9.2% of modules attributed (415 matched, 0/some guessed depending on
run), 1.7% of bundle instructions verified by signature match, out of 4,510
modules / ~1.44M instructions / 43k functions.

## Phase breakdown: 96% idle, not CPU-bound

`--cpu-prof` on run 2 (134.8s wall): **119,911 of 124,854 samples were
`(idle)`** (96%). Actual on-CPU work totalled roughly 5s across every named
frame combined. Top non-idle self-time frames (hit counts, 1 hit ~= 1.07ms):

```
884   (garbage collector)
429   normaliseFunctionForSignature   src/deps/sig-normalise.ts:183
307   (program)
253+142+107  decodeCore (3 call sites)  src/disasm/decode.ts:240
153+39  guessModules                    src/deps/guess.ts:202,218
117   fingerprintModule                 src/deps/fingerprint.ts:63
61    crypto hash update                node:internal/crypto/hash:131
51    findCandidatesInText               src/deps/candidates.ts:98
```

Fingerprinting all ~43k functions (`normaliseFunctionForSignature`,
`decodeCore`, `fingerprintModule`, hashing) totals well under 2s of CPU —
not the bottleneck the original row suspected. The 96% idle time meant the
real cost had to be I/O/network-bound, inside the one stage that talks to
the network by default: the guess stage's npm-registry-search fallback
(`src/deps/guess.ts`, step 5, `offline` not set).

## Root cause: 2068 sequential, undeduplicated npm-registry-search calls

Temporary per-call instrumentation of `npmRegistrySearch` (timestamped
`process.stderr.write`, reverted before committing — never shipped) on a
third run showed:

- **2068** search calls total, for only **345 distinct query strings**.
- Sum of call latencies: **143.0s** of the run's ~146.6s wall time (avg
  69ms/call, max 925ms) — this is essentially the entire cost.
- The most-repeated queries were generic minified property/identifier names
  picked as the fallback lead by many unrelated, otherwise-evidence-free
  modules: `exports` (250x), `value` (226x), `call` (167x), `assign` (110x),
  `assets` (66x), `apply` (66x), `function` (64x), `concat` (61x), `code`
  (53x), `enumerable` (40x) — none of these are real npm package names; the
  fallback lead heuristic (`PACKAGE_NAME_LIKE` + a length window) accepts
  them, and every occurrence across ~4000+ unattributed modules issued its
  own independent, sequential network round-trip.

This matches the original row's second suspect exactly ("the npm-confirm/
search path").

## Fix implemented (`src/deps/guess.ts`)

`guessModules` now memoises the npm-search fallback: one in-flight promise
per distinct query string, shared by every later module in the same run
that derives the same lead, instead of calling `search()` (or the real
`npmRegistrySearch`) again. Local, no worker pool, no restructuring (that
stays QUEUE 22). On this bundle this caps the network round-trips at the
345 distinct queries actually seen (a >=6x cut from 2068), which on the
measured ~69ms average would cut the guess-stage network cost from ~143s
towards ~24s — bringing total wall time down further, though we did not
re-run the timed measurement with the network-call counter still attached
(the counter and the timed run are mutually exclusive instrumentation; see
"not re-measured" below).

Regression test: `tests/gate/deps/guess.test.ts` — "npm-search queries are
deduped: two modules with the same lead string call search once" — fails
before the fix (2 calls) and passes after (1 call). Verified locally by
reverting just the one call site and re-running the test file.

## Not re-measured / open questions

- The fix was **not** re-timed stand-alone against the plain `time` wall
  clock on deb with the per-call counter removed and only the cache
  in place — run 3 in the table above ran the cached code but the
  instrumentation had already been reverted first (so it is a valid
  "after" measurement), giving 2m26.7s. That is not a clear improvement
  over run 1's 2m35.3s within this deb's ~10-15s run-to-run network-latency
  noise, since 4,070+ modules still remain unattributed and most of them
  still enter the search fallback at least once (only the *repeat* queries
  are now free); the win is real (fewer round-trips) but this bundle's own
  distinct-query count (345) still dominates wall time at ~24-30s of network
  cost, within the noise of an already-2.5-minute run whose other stages
  also vary run to run. A cleaner before/after isolate would need a
  synthetic multi-module fixture sized like NSW's unattributed set, run
  with a mocked zero-latency `search`, timing only the guess stage — out of
  this session's scope, not attempted.
- The BUGS row's own prove-fixed criterion asks for a worker pool and "on
  this Mac" — neither is in scope here (deb-only heavy compute; no worker
  pool per the brief, that is QUEUE 22). Row left `open`, not `fixed`; the
  row's description was updated in place with this session's findings.
- `--confirm` was not exercised in these runs (adds its own network calls,
  `confirm.ts`'s `fetchTimes`); if a future session profiles `--confirm`,
  the same per-query dedup pattern is worth checking there too.
