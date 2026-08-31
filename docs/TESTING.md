# Testing — the equivalence harness (M3)

This is the how-to for `src/harness/**` — the typed promotion of `tools/equiv/`
per `docs/specs/06-harness.md`. Read that spec first for the design rationale;
this document is the operator's manual: how to run each tier, what the trace
format and verdicts mean, how to add a fixture, and where this port
deliberately differs from the spec's literal text (and why).

## Running the tiers

```sh
npm test                 # gate tier only (fast, every commit)
npm run test:gate        # same as above, explicit
npm run test:sweep       # sweep tier (nightly/on demand — HBC2JS_TIER=sweep)
npm run test:all         # gate + sweep together

hbc2js gate                              # CLI: run the gate tier directly
hbc2js gate --json                       # machine-readable TierReport
hbc2js gate --only 01-if-else-chain      # restrict to named fixtures
hbc2js gate --versions 94,99             # restrict to HBC versions
hbc2js sweep                             # CLI: run the sweep tier
```

`hardened` and `local-corpus` are not separate CLI subcommands (per this
milestone's task boundary: "add `hbc2js gate|sweep` subcommands only") — run
them via the `runTier()` API directly, e.g. in a script or a test:

```ts
import { runTier } from "./src/harness/tiers.ts";
const report = await runTier({ tier: "hardened" });
```

`HBC2JS_REQUIRE_ORACLES=1` makes any hermesc/Hermes-VM-dependent test throw
instead of skip when the tool is missing — the existing
`tests/support/tiers.ts` convention, honoured throughout this harness's own
tests.

## Gate speed (npm-test-gate-speed, 2026-08-31)

`tests/gate/decompile/equivalence.test.ts` (T2, review-M4-H1's real-decompiler
acceptance run) used to be the gate's dominant cost — long enough that a plain
`npm test` could take 3+ minutes, and under the two regressions below, could
fail to terminate at all. In isolation it is now **~8s** (was unbounded/3+
min); the full 5-version matrix (moved to sweep, see below) is **~26s**. Three
changes, all in `src/harness/**`:

1. **`runHermesAsync` (`src/harness/hermes-vm.ts`), used by `ladder.ts`'s
   trace oracle instead of the old `runHermes`.** The Hermes-VM cross-check
   used `execFileSync` — synchronous, blocking Node's one event loop for its
   entire timeout window. `tiers.ts`'s `runTier` already pools fixtures at
   `cpus - 1` concurrency, but every one of those "concurrent" tasks shares
   one JS thread: the instant *any* of them hit the sync VM call, every other
   pending `runProgram`/VM call in the whole process stalled too, so the pool
   was serial in practice. `execFile` (async, callback-based) fixed this;
   `runHermes` itself is untouched (`src/cli.ts` and two test files call it
   directly, outside the pooled path).
2. **Gate vs sweep: which HBC versions.** The gate (`npm test`, every commit)
   now runs every construct fixture (plain + `.min`) plus `hermes-dec-sample`
   at `GATE_VERSIONS = [94, 99]` only — the representative subset
   `docs/HBC-FORMAT.md` calls out: v98's "two header layouts/tables" is the
   same split v94-vs-99 already crosses (v98's own remaining ambiguity is a
   *parser* concern, `KNOWN_AMBIGUOUS_V98`/`--force-v98-table`, not a
   distinct execution-semantics family), and v99 itself probes between its
   own two opcode tables per fixture. 84 and 96 are interpolations, not a new
   axis. The full 84/94/96/98/99 matrix moved to
   `tests/sweep/decompile/sweep.test.ts`'s new **T2-full** test (`npm run
   test:sweep`), so no version combination goes unchecked — just not on the
   per-commit critical path. 0-DIVERGENT is still enforced at both scopes.
3. **Two real `src/passes` regressions, found while measuring this, excluded
   non-silently.** `src/harness/tiers.ts`'s `KNOWN_HANGS` and
   `KNOWN_WRONG_OUTPUT` tables (both fully documented inline) exclude exactly
   three (fixture, version) combinations from every tier's *real-decompiler*
   run (the identity self-test is unaffected — it never calls `decompile()`):
   - `37-destructuring-array` (every version) and
     `48-optional-chaining-nullish` (v84/v94 only): `decompile()` never
     returns — confirmed as a genuine infinite loop (killed after 10 minutes
     on an otherwise idle machine), not mere slowness.
   - `01-if-else-chain.min` (v84/v94 only): decompiles to code that produces
     the *wrong output* (`-5 -> undefined` instead of `-5 -> negative`) —
     verified against the Hermes VM trace oracle, reproducible, not a flake.

   Both isolated to `src/passes/**` with `decompile(bytes, {..., passes:
   {none: true}})`: every case finishes in under 20ms with M5's passes
   disabled. Neither is this task's to fix (`src/passes/**` is out of scope
   here) — see `docs/AGENT-LOG.md`'s entry and `docs/BUGS.md`. Every
   exclusion appears in `TierReport.skippedByDesign` (`npm test`'s
   console.log always prints its count), the same non-silent mechanism a
   documented `versions.txt` compile failure already uses — nothing is
   dropped quietly. **`tests/gate/decompile/pipeline.test.ts`, `regressions.test.ts`
   and `review-M4-C1.test.ts` call `decompile()` directly (via
   `tests/support/m4.ts`'s `m4Binaries`), bypassing `tiers.ts` entirely — they
   are not protected by `KNOWN_HANGS`/`KNOWN_WRONG_OUTPUT` and will still hang
   on the two infinite-loop fixtures.** Those files are outside this task's
   owned surface (`tests/gate/decompile/equivalence.test.ts` only); until the
   underlying `src/passes` bug is fixed, a plain `npm test` across the *whole*
   gate can still fail to terminate even though T2 itself is fast — see
   `docs/STATUS.md`'s note.

   **Update (2026-08-31): both tables are gone.** The hangs were fixed with
   label-clean's re-enablement (`KNOWN_HANGS` removed then), and consolidation
   item 3 fixed the wrong output — expr-rebuild's dead-store scan stepped past
   an `if` that `break`s out of the site (`src/passes/expr-rebuild/match.ts`,
   `StepVerdict`) — and the class accessor-pair emit bug
   (`58-class-accessor-pair-split`, `src/emit/lower.ts`), then deleted
   `KNOWN_WRONG_OUTPUT` and its helper. `skippedByDesign` now lists
   documented `versions.txt` compile failures only; every fixture that
   compiles runs through the real decompiler in every tier.

## The four tiers (D13, D16)

| Tier | Inputs | Oracles | Reference | Where |
|---|---|---|---|---|
| `gate` | `constructs/*/vNN.hbc` + `.min.hbc` + `hermes-dec-sample` | syntax, trace, fuzz, roundtrip | `chooseReference` (D14) | `tests/gate/harness/tiers.test.ts` |
| `hardened` | `constructs/*/vNN.obf.hbc` | syntax, trace | `expected.txt`-equivalent (obfuscated source is behaviour-identical by construction) | `tests/sweep/harness/sweep.test.ts` |
| `sweep` | `bundles/**` | syntax, roundtrip only | n/a — bundles have no hand-written source | `tests/sweep/harness/sweep.test.ts` |
| `local-corpus` | `tests/fixtures/local-corpus/**` (gitignored) | syntax, roundtrip | n/a | `tests/sweep/harness/sweep.test.ts` — **INCONCLUSIVE, never skipped-as-pass, when absent** |

Every tier takes a `decompiler: DecompilerFn` option
(`(input) => candidateJsSourceText`). Until M4 exists, the default is
`identityDecompiler` — the candidate *is* the fixture's own `source.js` — which
lets the gate prove the harness itself: identity must PASS everything it can
(see "Known limitations" below for what it can't), and a deliberately mutated
candidate must DIVERGE. Once a real decompiler exists, pass it as
`decompiler` and the exact same tiers/oracles measure it.

## Verdicts

Three-valued at the trace level (`src/harness/compare.ts`'s `TRACE_VERDICT`):
`EQUIVALENT | DIVERGENT | INCONCLUSIVE`. **INCONCLUSIVE never counts as a
pass** — a timeout, a record cap, or a trace with no observable evidence
(no output, no error, no globals, no non-`undefined` return) is INCONCLUSIVE,
not EQUIVALENT. This is the guard against docs/EQUIVALENCE.md's R3 failure
mode: two truncated traces with an identical prefix comparing as "equal".

Four-valued at the oracle-ladder / tier level (`src/harness/ladder.ts`'s
`VERDICT`): `PASS | DIVERGENT | INCONCLUSIVE | ERROR`. `ERROR` is a harness
failure (the decompiler threw, hermesc is missing where required, an
unexpected exception) — distinct from `DIVERGENT`, which means the oracle ran
and found the candidate wrong. A `CheckResult.verdict` is the worst of the
oracles that ran; `CheckResult.caveats` lists any known-divergence construct
whose would-be DIVERGENT was downgraded to PASS (see below) — always
non-silent, always reported, never dropped.

## The oracle ladder (§2)

Cheapest and most specific first, stopping at the first real (non-caveated)
DIVERGENT or ERROR:

0. **syntax** — `node --check` the candidate.
1. **trace** — execution-trace equivalence (D2): the candidate and the
   fixture's own `source.js`, run in the same deterministic sandbox
   (`src/harness/sandbox.ts`), traced and compared record-by-record. When the
   reference policy says a matching Hermes VM exists, its trace of the
   *original bytecode* is an additional cross-check — a mismatch there is
   downgraded to a caveat (not a failure) for a construct
   `reference-policy.ts` already knows diverges from spec/Node at that
   version; otherwise it's a real DIVERGENT (the candidate itself is wrong,
   not merely different from source.js).
2. **fuzz** — differential calls into every function the program leaves on
   the global object (shares step 1's process run).
3. **roundtrip** — decompile candidate already done; recompile it with
   `hermesc` at the fixture's own version and embedded filename, decode both
   the original and the recompiled `.hbc` with `src/disasm`'s own
   parser/decoder, and diff a normalised per-function form. Reported as a
   ratchet (`exactFunctions/totalFunctions`), never a gate on absolute score
   — only a regression against `tests/golden/roundtrip-baseline.json` fails
   CI (`tests/sweep/harness/roundtrip-ratchet.test.ts`, HA-10).

## The trace format (§5)

NDJSON, one record per line, `k` (kind) discriminates:
`meta | out | hostset | call | yield | settle | tick | err | unhandled | ret |
globals | limit | end` — see `src/harness/trace.ts` for the exact shape of
each. `meta` carries a format version (`v: 1`) and the producing engine
string; it is never part of a comparison (`isComparable`). A trace also
carries a `kind`: `"full"` (Node sandbox — everything observable) or
`"print-only"` (bare Hermes VM — only what the program printed plus its
terminating error, because Hermes's `-b` path has no injectable prelude).
Comparing a print-only trace against a full one always compares the **print
projection of both, joined then re-split** — never record-by-record, because
one multi-line `print()` call is one record on the Node side and several
lines of raw Hermes stdout (HA-07; regression-tested against the exact shape
`43-template-literals` would break with a naive per-record compare). The
projection on both sides is the print lines **plus `uncaught <Name>` when the
program died of an uncaught throw** — `printProjection` (`trace.ts`, from the
main-phase `err` record) and `hermesPrintProjection` (`hermes-vm.ts`, from the
`Uncaught <Name>: …` report Hermes writes to stderr, kept apart from stdout).
Name only: the two engines word the same error differently (V8 "Cannot read
properties of null (reading 'x')", Hermes "Cannot read property 'x' of
null"), which is the same unsoundness `--relax error-messages` exists for. A
legitimately-throwing program is therefore PASS when the candidate throws the
same type at the same point, DIVERGENT when it doesn't throw or throws another
type (`tests/gate/harness/ladder-uncaught.test.ts`; CONSOLIDATION 25 — before
this, the candidate's print-only projection was compared against the VM's raw
stdout+stderr, so every such program looked DIVERGENT).

**Value encoding** (`makeEncoder`, `src/harness/trace.ts`) is deterministic,
side-effect-free, and never invokes a getter or reads `.stack`: `-0 !== 0`,
`1n !== 1`, `'1' !== 1`, `NaN` renders stably, own-property order is
preserved (unless `--relax key-order`), cycles get bounded first-encounter
ids, functions render as `[kind name/arity]`.

**Relaxations** — a refinement relation, not a convenience:

| Relax flag | Sound? | Default |
|---|---|---|
| `fn-names` | yes — names are erased by Hermes, recovery is out of scope | **on** |
| `key-order` | no — masks a genuine emitter bug | off |
| `error-messages` | no — masks a bad message reconstruction | off |

**Golden traces** (`src/harness/golden.ts`): `checkGoldenTrace(path, trace)`
compares against a committed NDJSON file, rewriting it only under
`HBC2JS_UPDATE_GOLDENS=1` (or `UPDATE_GOLDEN=1`, matching
`tests/support/golden.ts`'s existing convention) — HA-11.

## The reference policy (D14, §4)

`chooseReference(fixture, hbcVersion)` in `src/harness/reference-policy.ts`,
in order:

1. A matching Hermes VM exists (`findHermesVm`, `src/harness/hermes-vm.ts`,
   checking `$HERMES_VM_V<version>`, then `tools/hermes-vm/v<version>/bin/`,
   then `tools/hermesc/v<version>/`) → `"hermes-vm"`. The VM's own behaviour
   is the truth (D14), full stop — no caveat, regardless of whether the
   construct is independently known to diverge from spec/Node.
2. No VM, fixture is not a known-divergence construct → `"expected-txt"`, no
   caveat.
3. No VM, fixture *is* a known-divergence construct → `"expected-txt"` with a
   caveat, whether or not this exact version was itself measured — 96 and 98
   have no VM to measure with, and a construct known-divergent by name is
   assumed still divergent there rather than silently assumed fine.

`chooseReference` **throws** only for an HBC version outside
`KNOWN_VERSIONS` (`84, 89, 94, 96, 98, 99`) on a fixture that is *not* a
known-divergence construct — there the policy has no basis at all for
assuming `expected.txt` still matches Hermes, and refuses to guess (HA-06).

The four known Node-vs-Hermes divergences
(`18-closure-loop-let`, `20-let-const-tdz`, `42-rest-params`,
`49-arguments-object`) are `KNOWN_DIVERGENT_FIXTURES`, populated for
84/89/94/99 from `docs/AGENT-LOG.md`'s `tools/build-hermes-vm.sh`
measurement; 96/98 are explicitly left unmeasured (not assumed).

Two exclusion tables were added while proving the harness against the real
corpus (not in spec 06's original text — see "Deviations" below):

- `VM_LIMITATIONS` — `07-for-of-iterable`, `27-async-await-basic`,
  `28-async-await-error`, `29-promise-chaining`, `31-microtask-ordering` at
  v99: the source-built `tools/hermes-vm/v99/bin/hermes` throws inside its
  own `InternalBytecode.js` (`_makeAsyncIterator` is missing/broken in this
  particular build). Confirmed by direct invocation; falls back to
  `expected-txt` with a caveat rather than trusting a VM run that can't
  actually execute the construct.
- `NO_TRACE_REFERENCE` — `hermes-dec-sample`: its `source.js` does
  `window.onload = ...` unconditionally at top level, which the bare Hermes
  VM has no stub for at all (§3.2's mechanical limitation), while this
  harness's own Node sandbox does stub `window` — the two sides observe
  genuinely different environments for reasons that have nothing to do with
  a decompiler's correctness. `tools/equiv/selftest.mjs`'s own phase 3
  already excluded this fixture from the Hermes cross-check for the same
  reason; this makes that exclusion explicit and load-bearing.

## Adding a fixture

Fixture *creation* (source, licence, compiling with every hermesc) is
`tests/fixtures/README.md`'s job, unchanged by this milestone. Once a
fixture exists under `tests/fixtures/constructs/<name>/`, the harness picks
it up automatically — `runTier` discovers fixtures by walking the directory
tree, keyed on version and variant (`""`, `.min`, `.obf`). If it's one of the
four known-divergence constructs, or needs a version excluded from the Hermes
VM cross-check, add it to `reference-policy.ts`'s tables and say why, the
same way the existing entries do.

## Deviations from spec 06's literal text

- **No separate `hbc2js-equiv` binary.** This milestone's task boundary was
  explicit: add `hbc2js equiv`/`gate`/`sweep` as subcommands of the one
  `hbc2js` CLI (`src/cli.ts`, additive), not a second `package.json` `bin`
  entry. The effect spec 06 §1 wanted (the standalone wrapper script
  disappearing) is achieved either way.
- **`equiv normalise` takes two `.hbc` files, not two pre-dumped
  `hermesc -dump-bytecode` text files.** `src/harness/roundtrip.ts` never
  shells out to `hermesc -dump-bytecode`: both sides of every round-trip
  comparison are already ours (the original fixture and the
  recompiled-from-candidate file), decoded with `src/disasm`'s own
  parser, so normalising real dump *text* would be reimplementing a decoder
  spec 06 §6 itself says to import instead. `--json`/plain-text reporting
  and the similarity/first-divergence shape are unchanged.
- **The oracle ladder doesn't read `expected.txt`'s bytes.** Trace/fuzz
  compares the candidate live against the fixture's own `source.js` (which
  is exactly what `expected.txt` was captured from — see
  `tests/fixtures/README.md`'s own capture command). `chooseReference`'s
  `"expected-txt"` engine name describes *not* doing an additional
  Hermes-VM cross-check, not literally diffing that file's text.
- **`VM_LIMITATIONS` and `NO_TRACE_REFERENCE`** (above) are real findings
  from running the full gate identity check against genuinely-built VMs and
  a genuinely-idiosyncratic fixture — not anticipated by spec 06's text, but
  squarely inside D14/§3.2's own stated mechanical limits, handled the same
  way (fall back to `expected-txt`, with a caveat, never silently).
- **v96 has a working Hermes VM.** Spec 06 §3.1 states "96 and 98 have no
  VM"; `react-native@0.73.11`'s npm tarball (the same package
  `tools/get-hermesc.sh 96` already fetches for `hermesc`) turns out to also
  ship a working `hermes` interpreter, and this port's version-generic
  discovery order (`tools/hermesc/v<version>/hermes`, no hardcoded version
  list) picks it up without any special-casing. v98 genuinely has none.
- **Mutation kill-rate baseline is 270/318, not 273/318.** Re-measured
  against this port and today's fixture corpus (same 53-fixture/318-mutant
  size the PoC's 273 was measured against, but several fixtures' `source.js`
  have been edited since); adopted as this port's own HA-09 floor with the
  discrepancy documented inline in `tests/gate/harness/selftest.test.ts`,
  per spec 06 §6's own "re-derive rather than trusting the numbers" principle
  applied to the mutation baseline as well as the round-trip one.
- **`mutants()`'s `negate-condition` operator never fires.** `if (` ->
  `if (!(` inserts an unbalanced paren by construction, so it never passes
  `syntaxOk()` — a latent defect in the original `tools/equiv/src/mutate.mjs`,
  faithfully ported (not fixed) per the "behaviour-preserving" instruction.
  `tests/gate/harness/tiers.test.ts`'s mutation negative control uses
  `drop-statement` instead.
- **`tools/equiv/` is untouched**, marked deprecated (its README now points
  here) rather than deleted — per spec 06 §12's own instruction to keep it
  until the port is green and delete it in a separate, later commit.
