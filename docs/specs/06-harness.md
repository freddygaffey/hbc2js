# Spec 06 — Equivalence harness (M3)

**Milestone:** M3 (needed before M4 can be graded; the PoC already exists)
**Status:** ready to implement
**Owner model:** Sonnet, with Opus review of the reference-policy and verdict
logic (D5)
**Prerequisites:** specs 00–02; `tools/equiv/` (the working PoC)
**Consumers:** specs 05, 07, and every future pass

Reference: `docs/EQUIVALENCE.md` (the whole document — it is the design study
this spec promotes to a component), `docs/DECISIONS.md` **D2**, **D3**, **D13**,
**D14**, **D15**, **D16**; `tests/fixtures/README.md` (§"Sanity-checking: Hermes
VM (v84) vs. Node"); `tests/fixtures/OBFUSCATION.md`.

> **Ownership notice.** Do not edit `src/**`, `package.json`, `tests/**/*.test.ts`
> or `tools/equiv/**`. This spec describes the promotion; the M3 implementer
> performs it.

---

## 1. What this is, and what already exists

`tools/equiv/` is a **working proof of concept**, not a sketch: zero
dependencies, ESM, ~60 KB of source across 11 modules, 19 unit tests, and a
selftest that runs the whole 53-fixture corpus in ~40 s with measured results
(53/53 determinism, 273/318 mutation kill, 41/45 Hermes cross-check). D15 says
it "is the reference implementation to be promoted into `src/harness/`".

**Promotion means:** port to TypeScript under `src/harness/`, keep the algorithms
and the measured behaviour, add the things a PoC legitimately lacks (§4's
reference policy, §7's runners, typed verdicts, golden traces), and keep
`tools/equiv/` as the historical artefact until the port is green.

| PoC module | Becomes | Change |
|---|---|---|
| `src/trace.mjs` | `src/harness/trace.ts` | typed records, versioned `meta` |
| `src/sandbox.mjs` | `src/harness/sandbox.ts` | unchanged semantics |
| `src/child.mjs` | `src/harness/child.ts` | unchanged |
| `src/compare.mjs` | `src/harness/compare.ts` | typed verdicts |
| `src/fuzz.mjs` | `src/harness/fuzz.ts` | + generator drivers stay |
| `src/hermes.mjs` | `src/harness/hermes-vm.ts` | **+ v94/v99 VM discovery (§3)** |
| `src/normalise-disasm.mjs` | `src/harness/roundtrip.ts` | + per-function ratchet (§6) |
| `src/mutate.mjs` | `src/harness/mutate.ts` | + the R9 operators (§9 O-3) |
| `src/runner.mjs`, `cli.mjs` | `src/harness/runner.ts`, `src/cli-equiv.ts` | + tier runners (§7) |
| `selftest.mjs` | `tests/gate/harness/selftest.test.ts` | becomes a real test |
| `hbc2js-equiv` (executable shell wrapper, distinct from `src/cli.mjs`) | `package.json` `bin` entry → `dist/cli-equiv.js` | the wrapper disappears; npm's bin linking replaces it |
| `test/equiv.test.mjs` | `tests/gate/harness/*.test.ts` | **all 19 unit tests currently live in one file** — the port splits them per concern; do not go looking for a one-file-per-module layout that does not exist yet |
| `examples/rt-{original,decompiled-ok,decompiled-noisy}.js` | `tests/fixtures/harness/` | needed verbatim by §11 item 5 |

---

## 2. Verdicts and the oracle ladder

```ts
export type Verdict = "PASS" | "DIVERGENT" | "INCONCLUSIVE" | "ERROR";

export interface OracleResult {
  readonly oracle: OracleName;
  readonly verdict: Verdict;
  readonly detail?: string;
  /** Populated for DIVERGENT: first differing record and context (§8). */
  readonly divergence?: Divergence;
  readonly ms: number;
}
export type OracleName = "syntax" | "trace" | "fuzz" | "roundtrip";

export interface CheckResult {
  readonly fixture: FixtureRef;
  readonly verdict: Verdict;              // worst of the oracles that ran
  readonly oracles: readonly OracleResult[];
  readonly reference: ReferenceChoice;    // §4 — which engine produced the truth
  readonly budgets: BudgetReport;
}
```

The ladder, cheapest and most specific first, **stopping at the first DIVERGENT**
(`docs/EQUIVALENCE.md` §8):

```
0. syntax     node --check decompiled.js                 ~30 ms    everything
1. trace      execution-trace equivalence (D2)            ~90 ms    Tier 1
2. fuzz       differential function fuzzing               +~30 ms   Tier 1
3. roundtrip  recompile + normalised disassembly (D3)    ~150 ms    Tier 1 and 2
```

Steps 1 and 2 share one run of each program, so they are one cost.

**Three-valued, permanently.** INCONCLUSIVE is a real outcome: timeout, record
cap, timer budget, empty trace with no evidence, or a missing oracle. It never
counts as PASS. `docs/EQUIVALENCE.md` R3 names the exact failure mode — two
truncated traces with equal prefixes compare equal — and the PoC has a unit test
guarding it. **Never allow a two-valued verdict**; that guard test is
load-bearing and must survive the port.

---

## 3. The Hermes VM oracle (D14)

### 3.1 Availability, as it now stands

`docs/EQUIVALENCE.md` §5.1 recorded that only HBC ≤ 89 had a VM. That has
changed: `tools/build-hermes-vm.sh <94|99>` builds one from source at the pinned
commit, and `tools/hermes-vm/v94/bin/hermes` and `tools/hermes-vm/v99/bin/hermes`
now exist.

```ts
export interface HermesVm { readonly hbcVersion: number; readonly path: string; }
export function findHermesVm(version: number): HermesVm | null;
```

Discovery order, first hit wins:

1. `process.env[`HERMES_VM_V${version}`]`
2. `tools/hermes-vm/v<version>/bin/hermes`   ← source-built (94, 99)
3. `tools/hermesc/v<version>/hermes`         ← prebuilt, v84 only

Available today: **84** (prebuilt), **94** and **99** (source-built). **96** and
**98** have no VM — 96 could be built (same classic lineage as 94), 98 probably
cannot (no published source drop, and `hermes-compiler` ships `hermesc` only).

**The VM refuses any bytecode whose version is not exactly its own** — there is
no forward or backward compatibility, and the error is
`Wrong bytecode version. Expected N but got M`. So a VM is only ever used for its
own version, and a missing VM is INCONCLUSIVE, never a silent fallback to Node
(that fallback *is* the §5.2 mistake).

### 3.2 Mechanical limits (unchanged by the new builds)

* **No prelude can be injected into a `-b` run.** Passing a `.js` and a `.hbc`
  together fails with `Multiple files must use CommonJS modules`. So the Hermes
  side has no stubbed `Math.random`/`Date.now`, and its trace is *only* what the
  program printed plus its terminating error.
* Bare Hermes has no `console`, no `setTimeout`, no DOM; `print` is the only
  channel. That is exactly the `tests/fixtures/README.md` fixture convention,
  which is why this works.

Consequence: the Hermes oracle produces a **print-projection trace**, a strictly
weaker record set than the Node sandbox's. Model it explicitly rather than
pretending the two are the same shape:

```ts
export type TraceKind = "full" | "print-only";
export interface Trace { readonly kind: TraceKind; readonly records: readonly TraceRecord[]; }
```

Comparing a `print-only` trace against a `full` one compares the **print
projection of both** (and per §11 of EQUIVALENCE, compares it as *joined text*
re-split, never record-by-record — a multi-line template literal is one record
and several lines).

---

### 3.5 Budget symmetry in the cross-check (P-16)

The two sides of the cross-check are bounded by **different** budgets: the
candidate's trace by `maxRecords` (5 000 in the fuzz tools, 20 000 by default)
*and* the timeout, the VM's stdout only by the timeout. Compared naively, any
non-terminating program therefore differs at whichever side stopped first — a
verdict that measures machine load rather than the decompiler (measured on
`v84-seed778059`: 3 389 470 VM lines against 4 999 candidate records, identical
up to the cut-off; 110 of 159 campaign finds were this artifact).

Rule: cap both sides to the same number of **lines** before comparing (line
level, not record level, per §3's joined-text rule), and drop the last capped
line, which a VM killed by the timeout can have written only half of. Then:

- an inequality inside the capped prefix → DIVERGENT, as before;
- an equal capped prefix where **both** sides hit a budget → INCONCLUSIVE
  (`budget`), never DIVERGENT and never vm-agrees evidence;
- an equal prefix where only *one* side hit a budget → DIVERGENT: the side
  that ran to completion is total information, and "terminated after k lines"
  versus "still going at k lines" is a real behaviour difference (this is what
  `tests/gate/harness/selftest.test.ts`'s HA-09 mutation kill rate detects for
  a mutant that turns a loop infinite — an either-side rule costs 8 mutants).

`compareTraces` follows the same three-way rule for record traces, and stops
comparing at the earliest `limit` record on either side: a budget marker is not
an observation, and lining it up against the other side's next real record
turns every cut-off into a divergence.

## 4. Reference policy — which engine is the truth (D14)

The single most consequential piece of configuration in the project.

```ts
export type ReferenceEngine = "hermes-vm" | "expected-txt" | "node-source";

export interface ReferenceChoice {
  readonly engine: ReferenceEngine;
  readonly reason: string;                  // human-readable, appears in reports
  readonly vm?: HermesVm;
  /** Constructs known to diverge between this engine and the spec. */
  readonly knownDivergences: readonly string[];
}
export function chooseReference(fixture: FixtureRef, hbcVersion: number): ReferenceChoice;
```

Rules, in order:

1. **A matching Hermes VM exists** → `hermes-vm`, running the fixture's *own
   `.hbc`*. This is the truth (D14): the decompiler must reproduce the
   bytecode's behaviour, not the source's.
2. **No matching VM, fixture is not in the known-divergence set** →
   `expected-txt` (the committed Node-captured stdout).
3. **No matching VM, fixture *is* in the known-divergence set** →
   `expected-txt` **with the divergent constructs flagged**, and the result is
   reported as PASS-with-caveat in the report, counted separately in the summary.
   Never silently.

The known-divergence set, from `docs/EQUIVALENCE.md` §5.2 and
`tests/fixtures/README.md`, measured at v84, reproduced at v89, and **since
confirmed unchanged at v94 and v99** under the source-built VMs
(`docs/AGENT-LOG.md`, the `tools/build-hermes-vm.sh` entry: ten fixtures
including all four of these were run under both new VMs against `expected.txt`):

| Fixture | Node / spec | Hermes 84 / 89 / 94 / 99 |
|---|---|---|
| `18-closure-loop-let` | `0,1,2` | `3,3,3` |
| `20-let-const-tdz` | inner-block TDZ `ReferenceError` | `outer` (no TDZ) |
| `42-rest-params` | `arguments` aliasing mutates | `original` |
| `49-arguments-object` | `changed-via-arguments` | `original` |

So the table ships **populated for 84, 94, 96 (inferred: v96 is the same classic
lineage as v94 — mark it unmeasured until checked), 98 and 99**, not empty. That
matters because `HA-06` makes the policy throw on an unmeasured pair, and an
empty table would have blocked the gate for every v94/v99 fixture touching these
four constructs — which is spec 05 §12's own acceptance criterion.

**This table is machine-readable data, not prose.** It lives in
`src/harness/reference-policy.ts` as a versioned map keyed by
`(fixture, hbcVersion)`, and it is the fix for `docs/EQUIVALENCE.md` §9 item 2
("without this the harness reports 4 permanent false failures").

**Still unmeasured: v96 and v98.** v96 has a VM only if one is built
(`tools/build-hermes-vm.sh` covers 94 and 99 today) and v98 has none at all —
`hermes-compiler` ships `hermesc` only. The policy module keys on version and
**fails loudly** for an unmeasured pair rather than assuming the v84 answer; for
v96/v98 fixtures touching these four constructs that means `expected-txt` with
the caveat flag (rule 3), not a throw, because the constructs are known-divergent
by name. Extending `build-hermes-vm.sh` to 96 would close it — v96 is the same
classic-Hermes lineage as v94, so the build recipe should carry over.

---

## 5. Trace format

Adopt the PoC's format verbatim (`docs/EQUIVALENCE.md` §2.1): NDJSON, one record
per line, kinds `meta | out | hostset | call | yield | settle | tick | err |
unhandled | ret | globals | limit | end`. Two additions:

1. **A format version in `meta`** (`{k:"meta", v:1, engine, seed}`), so committed
   golden traces survive harness changes. Comparison ignores `meta`.
2. **`kind` on the trace itself** (§3.2), so a print-only Hermes trace cannot be
   accidentally compared field-for-field against a full one.

The value encoder's rules are non-negotiable and each exists because the naive
version is wrong (§2.2 of EQUIVALENCE): `-0 ≠ 0`, `1n ≠ 1`, `'1' ≠ 1`, stable
`NaN`, **own-property order preserved**, getters never invoked, `.stack` never
read, bounded cycles with first-encounter ids, functions as `[fn name/arity]`.

**Relaxations** are a refinement relation, not a convenience:

| `--relax` | Sound? | Default |
|---|---|---|
| `fn-names` | **yes** — names are erased by Hermes and SPEC puts recovery out of scope | **on** |
| `key-order` | no — masks a genuine emitter bug (EM-06) | off |
| `error-messages` | no — masks bad message reconstruction | off |

"A fixture that needs three relax flags to pass is not passing" (R5). Record the
active relaxations in every report line.

**Golden traces.** Committed NDJSON per `(fixture, version, engine)` under
`tests/golden/traces/`, with an explicit `--update-goldens`, so trace changes are
reviewed in diffs rather than silently re-baselined — the same discipline
`expected.txt` already gets.

---

## 6. Round-trip oracle and the per-function ratchet

Decompile → `hermesc -emit-binary` at the fixture's version → disassemble both →
normalised diff. Two prerequisites, both already known:

* The recompile must use **the same Hermes build** (v99 has two opcode tables
  without a version bump, and a different builtin table changes
  `GetBuiltinClosure` operands).
* The decompiled file must be compiled **with a matching relative filename**,
  because the name is embedded even without `-g`.

The original side is **our own disassembler** (spec 02) rendered in `hermesc`'s
text format — `hermesc -dump-bytecode` takes source, not `.hbc`, so it can only
produce the decompiled side. Getting our disassembler to agree with
`hermesc -dump-bytecode` is spec 02's acceptance criterion, and this oracle then
also exercises it.

Normalisation (PoC-proven, `docs/EQUIVALENCE.md` §4.2): drop `Source hash:`,
header counts, the whole `Global String Table:`, everything from `Debug * table:`
onward, and `Offset in debug table:`; rename registers by first appearance
(`%0`, `%1`, …) and labels (`@0`, `@1`, …); mask inline-cache slots to `#`; mask
function names to `~` (keep `global`); drop `N registers, M symbols`; **keep**
parameter counts.

**Report a ratchet, not a percentage.**

```ts
export interface RoundTripReport {
  readonly totalFunctions: number;
  readonly exactFunctions: number;          // normalised body identical
  readonly ratchet: number;                 // exactFunctions / totalFunctions
  readonly regressions: readonly { fn: number; wasExact: boolean }[];
}
```

The reason is measured, not aesthetic: first-use register renaming is a canonical
form that is **not robust to local edits** — one extra instruction needs one
extra register, which shifts every subsequent register number and drags a
one-token difference from 100% to 72%. So use exact match per function as the
unit, commit a baseline (`tests/golden/roundtrip-baseline.json`), and **fail CI
on regression, never on absolute score**. droidsaw-hermes uses the same shape.

A stronger canonical form (def-use / SSA register numbering) is the escalation if
the ratchet stalls; not worth doing first (§9 O-4 of EQUIVALENCE).

---

## 7. Runners (D13, D16)

```ts
export type Tier = "gate" | "sweep" | "hardened" | "local-corpus";

export interface RunnerOptions {
  readonly tier: Tier;
  readonly versions?: readonly number[];    // default: all a fixture compiles at
  readonly oracles?: readonly OracleName[]; // default per tier, below
  readonly seeds?: number;
  readonly budgets?: Partial<Budgets>;
  readonly concurrency?: number;            // default os.cpus().length - 1
}
export function runTier(o: RunnerOptions): Promise<TierReport>;
```

| Tier | Inputs | Oracles | Reference | CI |
|---|---|---|---|---|
| **gate** | `constructs/*/vNN.hbc` (243) + `hermes-dec-sample` (6) + `constructs/*/vNN.min.hbc` (243) | syntax, trace, fuzz, roundtrip | §4 policy | every commit |
| **hardened** | `constructs/*/vNN.obf.hbc` (241) | syntax, trace (fuzz optional) | `expected.txt` — the obfuscated source is behaviour-identical by construction, verified at generation time | nightly (D13 puts obf in sweep) |
| **sweep** | `bundles/**` (C3) + hardened bundles (C4) + harvested lit/test262 corpora | syntax, roundtrip only — bundles cannot execute outside an RN host | n/a | nightly |
| **local-corpus** | `tests/fixtures/local-corpus/**` (C5, gitignored) | syntax, roundtrip | n/a | sweep; **INCONCLUSIVE when absent**, never skipped-as-pass |

Notes that matter:

* The **minified** variants belong in the gate: they are a *control* — Hermes
  erases names anyway, so `vNN.min.hbc` should behave exactly like `vNN.hbc`. A
  divergence there is a genuine finding. (`OBFUSCATION.md` measured that terser's
  `compress` does slightly more than name erasure on `01-if-else-chain` and
  `22-nested-closures-counters`; that is source-level, and the *behaviour* is
  still identical.)
* The **obfuscated** variants are the CFG-shape stressor: 5.4×–8.8× the
  instructions, 3.6×–7.7× the basic blocks. They must still PASS, with generous
  budgets.
* Counts are as of this revision, over **five** versions (84, 94, **96**, 98,
  99) and 53 constructs — re-derive them from the tree rather than trusting the
  numbers. `30-async-generator` has **no** `.hbc` at any version (no fetched
  hermesc compiles `async function*`), and a documented set of fixture×version
  combinations does not compile. The runner reads each fixture's `versions.txt` and reports those as
  **skipped-by-design**, a distinct category from INCONCLUSIVE.
* C5 rules (D16): never commit the bundles or anything derived from them; only
  `MANIFEST.json` (sha256 + Hermes version) is committed.

---

## 8. CLI

Extend the PoC's surface (`docs/EQUIVALENCE.md` §10) rather than inventing one:

```
hbc2js-equiv <a.js> <b.js>                execution-trace comparison
hbc2js-equiv --hbc <a.hbc> <b.js>         original bytecode vs decompiled JS
hbc2js-equiv normalise <a.txt> <b.txt>    normalised disassembly diff (D3)
hbc2js-equiv tier <gate|sweep|hardened|local-corpus>      run a whole tier
hbc2js-equiv check <fixture.hbc>          decompile with hbc2js, then full ladder

  --timeout <ms>       wall clock per program (default 5000)
  --seed <n> / --seeds <n>
  --fuzz[=<n>]         tuples per exported function (default 50)
  --relax <list>       fn-names,key-order,error-messages   (default fn-names)
  --engine node|hermes|auto
  --hermes <path>      explicit VM binary
  --reference auto|hermes-vm|expected-txt   (default auto, per §4)
  --trace-out <dir>    write both NDJSON traces
  --update-goldens
  --json               machine-readable
  --quiet

exit 0 PASS   1 DIVERGENT   2 INCONCLUSIVE   3 harness error
```

`--hbc` without a matching VM reports INCONCLUSIVE and **names the versions that
are available**; it does not fall back to Node.

Divergence reports show the first differing record with three records of context
each side, and — new in the port — the `lineMap` entry (spec 05) for the
decompiled side, so a divergence points at a bytecode offset:

```
DIVERGENT — traces diverge at record 12   (decompiled.js:214 ← fn#5 @0x1e)

    11   out print "start"
    12 - out print "3,3,3"
    12 + out print "0,1,2"
```

---

## 9. CI wiring

Per spec 00 §8 (`ci.yml` gate, `sweep.yml` nightly):

* **gate job** — after `npm run test:gate`, run `hbc2js-equiv tier gate --json`
  and fail on any DIVERGENT or ERROR; INCONCLUSIVE fails too **unless** the
  fixture is in a committed, reviewed `tests/golden/inconclusive-allowlist.json`
  with a reason. That allowlist must shrink over time and is reported in the job
  summary.
* **sweep job** — `tier sweep` and `tier hardened`; upload `TierReport` JSON as
  an artefact; compare the round-trip ratchet against
  `tests/golden/roundtrip-baseline.json` and fail on regression.
* **harness self-test** — the PoC's three phases become a gate test:
  determinism (every fixture traced twice in independent processes must be
  identical), fidelity (the print projection equals `expected.txt`), and
  **mutation kill rate** with a floor. The baseline is 273/318 (85.8%); CI fails
  if it drops. A kill rate that falls means the harness got weaker
  (`docs/EQUIVALENCE.md` §9 item 5).
* **VM availability** — CI builds or caches the Hermes VMs
  (`tools/build-hermes-vm.sh`) keyed on the script hash; if unavailable, the
  gate runs with `--reference expected-txt` and the job summary says so loudly.

---

## 10. Invariants

| # | Invariant | Violation |
|---|---|---|
| HA-01 | verdicts are three-valued + ERROR; no code path maps INCONCLUSIVE → PASS | unit test (ported from the PoC) |
| HA-02 | a timeout emits a `limit` record, never an `err` | unit test |
| HA-03 | a divergence before a hang is still DIVERGENT | unit test |
| HA-04 | a trace with no evidence records is INCONCLUSIVE | unit test |
| HA-05 | `--hbc` never falls back to Node when the VM is missing | unit test |
| HA-06 | the reference policy fails loudly on an unmeasured `(fixture, version)` | unit test |
| HA-07 | print projections are compared as joined text, not record-by-record | regression test on `43-template-literals` |
| HA-08 | the sandbox is deterministic: same seed → byte-identical trace, in a fresh process | selftest phase 1 |
| HA-09 | mutation kill rate ≥ the committed baseline | selftest phase 2 |
| HA-10 | round-trip ratchet ≥ baseline | sweep job |
| HA-11 | golden traces are only rewritten under `--update-goldens` | unit test |

---

## 11. Test plan

1. **Port parity.** Every one of the PoC's 19 unit tests passes against the TS
   port, unchanged in intent. Any behaviour change is a deliberate, documented
   decision, not a porting accident.
2. **Selftest as a gate test** (§9): 53/53 determinism + fidelity, kill rate
   ≥ 273/318, Hermes cross-check 41/45 at v84 — and, once §4 O-1 is measured, the
   equivalent numbers at v94 and v99.
3. **Reference policy.** Unit tests for all three rules of §4, including the
   loud failure on an unmeasured version.
4. **Tier runners.** Each tier runs end-to-end on a 3-fixture subset in unit
   tests; the full tiers run in CI.
5. **Round-trip.** Reproduce EQUIVALENCE §4.3's measured result exactly:
   `rt-original.js` vs `rt-decompiled-ok.js` → EQUIVALENT; vs
   `rt-decompiled-noisy.js` → DIVERGENT at 72.1% similarity. Those example files
   already exist in `tools/equiv/examples/` and must come across with the port.
6. **Hermes VM.** With v94/v99 VMs present, every gate fixture that compiles at
   that version runs under its own VM and the reference choice is `hermes-vm`.
   Without them, the choice is `expected-txt` and the report says so.

---

## 12. Acceptance criteria

- [ ] `src/harness/**` exists in TypeScript with the module map of §1 and no new
      runtime dependencies.
- [ ] All 19 PoC unit tests pass against the port.
- [ ] The selftest runs as a gate test: 53/53 determinism, fidelity byte-exact
      against `expected.txt`, mutation kill ≥ 273/318.
- [ ] `chooseReference` returns `hermes-vm` for v84/v94/v99 when the VM is
      present, `expected-txt` otherwise (v96/v98 have no VM), and throws on an
      unmeasured, not-known-divergent `(fixture, version)` pair.
- [ ] The four known divergences are data in `reference-policy.ts`, keyed by
      version, **populated for 84/94/99 from the AGENT-LOG measurement**, with
      96 and 98 explicitly marked unmeasured; a unit test asserts the policy
      throws for an unmeasured *non*-divergent pair and returns
      `expected-txt`-with-caveat for an unmeasured *known-divergent* one.
- [ ] `hbc2js-equiv tier gate` runs the whole gate tier and produces a
      `TierReport` with per-fixture verdicts and timings.
- [ ] `--hbc` with a missing VM exits 2 (INCONCLUSIVE) and names available
      versions; a test asserts it never runs Node instead.
- [ ] Round-trip produces a per-function ratchet and a committed baseline; a
      synthetic regression makes CI fail.
- [ ] HA-01…HA-11 each have a test.
- [ ] `tools/equiv/` is untouched by this work until the port is green; the
      commit that removes it (if any) is separate and references this spec.

---

## 13. Estimated complexity

**Sonnet, with an Opus review of §4 and §2.** The algorithms exist and are
measured; this is a port plus four genuinely new pieces (reference policy, tier
runners, typed verdicts, golden traces).

| Component | Size | Model |
|---|---|---|
| port of trace/sandbox/child/compare/fuzz | ~1200 lines TS | Sonnet |
| `hermes-vm.ts` (discovery, print-only traces) | ~200 lines | Sonnet |
| **`reference-policy.ts`** | ~150 lines — small, and the most consequential file in the harness | **Opus review** |
| `roundtrip.ts` + ratchet | ~350 lines | Sonnet |
| `runner.ts` (tiers, concurrency, budgets) | ~400 lines | Sonnet |
| CLI + reporting | ~350 lines | Sonnet |
| tests | ~900 lines | Sonnet |

---

## 14. Open questions for the overseer

* **O-1 — ~~measure the divergences at v94 and v99~~ RESOLVED, with a
  remainder.** `docs/AGENT-LOG.md` already records the measurement: all four
  persist unchanged at v94 and v99. Folded into §4's table. What remains is
  **v96 and v98**: v96 needs `tools/build-hermes-vm.sh` extended (same lineage
  as v94, should be cheap); v98 has no VM at all and may never have one. Do we
  build a v96 VM, and where is the table's single source of truth —
  `reference-policy.ts` (my proposal, with `tests/fixtures/README.md` pointing at
  it) or the README?
* **O-2 — `expected.txt` vs Hermes as ground truth.** `docs/EQUIVALENCE.md` O-2
  flags that the README currently treats `expected.txt` (Node) as the oracle
  while D14 says the VM is. §4 resolves it in favour of the VM. Confirm, and the
  README needs a sentence changing.
* **O-3 — mutation operators for the bug classes we actually fear.** The 85.8%
  kill rate says nothing about closure env-slot mix-ups, `finally` duplication
  errors, or generator resume-point bugs, because no operator models them
  (EQUIVALENCE R9). Three targeted operators would make the number mean what it
  appears to mean. Worth a task now, or after M4?
* **O-4 — coverage measurement.** V8's coverage API would quantify R1 ("the
  trace only covers the path taken") cheaply and tell us how much fuzzing is
  enough. Add to M3, or defer?
* **O-5 — retire `tools/equiv/`?** Once the port is green, keeping two
  implementations invites drift. My preference: delete it in a separate commit
  and keep `docs/EQUIVALENCE.md` as the record. Agree?

---

## 15. Review responses (`docs/specs/REVIEW-03-07.md`)

| Item | Verdict | Where |
|---|---|---|
| **S4** §4 and O-1 presented "measure the v94/v99 divergences" as open when `docs/AGENT-LOG.md` had already answered it, and `HA-06` would then have blocked the gate | **Fixed** | §4's table is now populated for 84/89/94/99 citing the AGENT-LOG entry, with an explicit statement that it ships populated rather than empty and why that matters for `HA-06`; the "open measurement" paragraph is narrowed to the genuinely remaining cases (**v96 and v98**, neither of which has a VM); O-1 is marked RESOLVED with that remainder; §12's acceptance bullet now requires the populated rows and distinguishes the two unmeasured outcomes (throw vs `expected-txt`-with-caveat) |
| **N3** §1's promotion table omits the `hbc2js-equiv` wrapper and the fact that all 19 tests live in one file | **Fixed** | Three rows added to the table: the wrapper (which disappears into npm bin linking), `test/equiv.test.mjs` with a note not to expect a per-module split, and `examples/rt-*.js`, which §11 item 5 needs verbatim |
| **N3's positive finding** (the promotion table otherwise matches `tools/equiv/`'s real tree one-to-one; no defect) | Acknowledged, unchanged | Recorded so it is not re-checked |
| B1, B2, S1, S2, S3, S5, S6, N1, N2 | Not this spec's | B1/S2/S6 in spec 03; S1 in spec 04; B2/S3 in spec 05; S5/N1/N2 in spec 07 |

**Beyond the review.** HBC **96** is now fetched and fixtured, so §3.1's VM
availability, §7's tier inputs and every count were refreshed: five versions,
249 gate binaries, 241 obfuscated. v96's absence from the VM set is a new,
concrete gap that O-1 now carries.
