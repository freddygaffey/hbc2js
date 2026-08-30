# Semantic equivalence: how hbc2js knows its output is right

Design study for the M3 harness. Implements and evaluates the oracles named in
`docs/DECISIONS.md` D2 (execution-trace equivalence) and D3 (recompile
round-trip), plus three alternatives, against the real fixture corpus.

A working proof of concept lives in [`tools/equiv/`](../tools/equiv/); every
number in this document is reproducible with `node tools/equiv/selftest.mjs
--hermes --fuzz` (~40 s) and `node --test 'tools/equiv/test/*.test.mjs'`.

---

## 0. Recommendation, up front

**Run four oracles in a fixed order, cheapest and most specific first, and stop
at the first DIVERGENT.**

| # | Oracle | Cost per fixture | Runs on | Catches |
|---|---|---|---|---|
| 1 | `node --check` on the emitted JS | ~30 ms | everything | emitter producing non-JS |
| 2 | Execution-trace equivalence in `node:vm` (D2) | ~45 ms/program | Tier 1 (pure JS) | ~85% of injected faults |
| 3 | Differential function fuzzing on top of the same run | +~15 ms | Tier 1 | code the fixture's own output never reaches |
| 4 | Recompile round-trip, normalised disassembly diff (D3) | ~150 ms | Tier 1 **and** Tier 2 (RN bundles) | everything execution missed, at the cost of false positives |

Plus one **reference-semantics correction** that is not optional:

> **When a `.hbc` fixture and a matching Hermes VM binary both exist, the
> reference trace must come from running that `.hbc` under Hermes — not from
> running the original `.js` under Node.**

That is the single most important finding here, and it is not a theoretical
concern. On 4 of 45 v84 construct fixtures, Hermes and Node genuinely disagree
about what the *same source* means (§5.2). For those, "decompiled output matches
the original source's Node behaviour" is the *wrong* success criterion: a
correct decompiler of Hermes v84 bytecode must reproduce Hermes's behaviour,
because that is what the bytecode encodes.

Static/normalised-AST comparison (§6) is **not** recommended as an oracle. It is
recommended as a *debugging aid* — as the thing you look at after an oracle
fails, not as the thing that decides.

---

## 1. What "equivalent" has to mean

Two programs are equivalent if no observer can tell them apart. That is
undecidable, so every practical oracle picks a weaker, decidable proxy and
accepts one of two error modes:

- **Under-approximation** (execution tracing): everything it calls DIVERGENT
  really is different, but it calls things EQUIVALENT that are not — it only
  observed one path.
- **Over-approximation** (round-trip bytecode diff): everything it calls
  EQUIVALENT really is equivalent, but it calls things DIVERGENT that are
  perfectly fine — an idiom difference is not a semantic difference.

The PoC demonstrates both error modes on the same pair of files
(`tools/equiv/examples/rt-*.js`, §4.3): execution tracing says EQUIVALENT for a
pair the round-trip check calls 72% similar, and the round-trip check is the one
that is wrong about equivalence — but it is also the only one that can run on a
12 MB RN bundle. They are complementary, not ranked.

The observation boundary for hbc2js is **the host API surface plus program
completion**, because that is all a React Native app is: bytecode that calls out
to a host. Concretely: what the program printed, what it threw, what it left on
the global object, what it wrote to host objects, and in what order.

---

## 2. Oracle 1 — differential execution with a trace (D2)

### 2.1 Trace format

A trace is an ordered sequence of **records**, serialised as NDJSON — one JSON
object per line. NDJSON rather than a single JSON document for two reasons:
a child process that is about to be `SIGKILL`ed has already flushed everything
up to the last complete line, and comparison is a linear scan to the first
differing line.

Every record has a kind `k`. The full set (`tools/equiv/src/trace.mjs`):

| `k` | Fields | Meaning |
|---|---|---|
| `meta` | `engine`, `seed` | informational; excluded from comparison |
| `out` | `ch`, `s`, `a` | a host output call. `ch` is the channel (`print`, `console.log`, `console.error`, `alert`, …), `s` is the Hermes-style rendered line (`String(arg)` joined by spaces), `a` is the array of *structurally encoded* arguments |
| `hostset` | `o`, `p`, `v` | assignment to a stubbed host object (`window.onload = …`) |
| `call` | `fn`, `args`, `ret` \| `throws` | a fuzz-driven call (§3) |
| `yield` | `fn`, `i`, `done`, `v` | one step of a harness-driven generator |
| `settle` | `id`, `state`, `v` | an observed promise settlement |
| `tick` | `t` | virtual-clock boundary; emitted when the timer queue advances |
| `err` | `phase`, `name`, `message` | an error that ended a phase (`parse`, `main`, `timer`, `microtask`, `drain`) |
| `unhandled` | `name`, `message` | an unhandled rejection, collected at end of run |
| `ret` | `v` | the program's completion value |
| `globals` | `v` | own properties the program added to the global object, sorted by key |
| `limit` | `why` | a budget was exhausted (`timeout`, `sync-timeout`, `record-cap`, `timer-budget`) |
| `end` | — | clean termination |

Two channels per output call (`s` and `a`) is deliberate. `s` is what the
program actually printed and is directly comparable against a fixture's
`expected.txt` and against a real Hermes run. `a` is strictly stronger: the
sample fixture's `console.log('a', gen().next())` renders as the useless string
`a [object Object]` but encodes as `{value: 42, done: false}`.

### 2.2 Value encoding

The encoder (`makeEncoder`) is total, deterministic, and side-effect-free. Rules
that matter, each of which exists because the naive version is wrong:

- **`-0` ≠ `0`, `1n` ≠ `1`, `'1'` ≠ `1`, `NaN` is stable.** `===` and
  `JSON.stringify` all get at least one of these wrong.
- **Own-property order is preserved**, because it is observable in JS
  (`Object.keys`, `for...in`, `JSON.stringify`). `--relax key-order` sorts it
  for decompilers that cannot preserve insertion order.
- **Getters are never invoked** — they can have side effects, and invoking them
  from the encoder would make the trace depend on the tracer. They encode as
  `<accessor>`.
- **`.stack` is never read.** It embeds file names, line numbers, and — for a
  `RangeError` from deep recursion — an engine- and build-specific depth.
  Errors encode as `Name("message")` plus own enumerable properties and `cause`.
- **Cycles and depth are bounded** with first-encounter identity ids, so the
  same object graph built in the same order encodes identically without the
  encoder ever depending on allocation addresses.
- **Functions encode as `[fn name/arity]`**, with `--relax fn-names` masking the
  name. Decompiled functions carry generated names (`_fun0`), so the strict form
  will fail on any fixture that prints a function; the relaxed form is the
  realistic default for decompiler output, and the strict form is for
  source-vs-source regression testing of the harness itself.

### 2.3 Pinning nondeterminism

The sandbox is a `node:vm` context whose every nondeterministic input is
replaced (`tools/equiv/src/sandbox.mjs`):

- `Math.random` → seeded xorshift128+. Seed is a CLI parameter, so a failure is
  reproducible from the seed alone, and `--seeds N` re-runs across several.
- `Date.now()` and `new Date()` → frozen at `1700000000000` (a `Proxy` on the
  constructor, so the zero-argument form is caught too).
- `performance.now()` → the virtual clock.
- `setTimeout`/`setInterval`/`setImmediate` → a virtual scheduler; see §2.4.
- `print`, `alert`, `console.*` → trace emitters.
- `window`, `document`, `navigator`, `self` → recording `Proxy` stubs. Reads
  return further stubs (so `a.b.c.d` never throws and never diverges between
  the two sides); writes emit `hostset` records. This is what makes RN-shaped
  code observable without a React Native host.

Everything else in the context is Node's own realm. That is a known gap, not an
oversight — see risk R6.

### 2.4 Async ordering, microtasks, and timers

Promise microtask ordering is fully determined by the spec and by program
structure, and both programs run on the same engine in the same process model.
So the *order in which trace records are emitted* already captures microtask
interleaving; nothing extra is needed. The unit test
`microtask interleaving is captured` verifies this by swapping two independent
statements that schedule microtasks and confirming DIVERGENT.

Timers are different, because a real `setTimeout(f, 100000)` would make the
harness take 100 seconds. The sandbox replaces them with a **virtual clock**:

1. Run the program body.
2. `await` a `setImmediate` — which, in Node, runs in the check phase *after*
   the microtask queue is fully drained. This is the reliable "microtasks are
   done" primitive; a fixed number of `Promise.resolve()` hops is not.
3. Pop the earliest pending timer by `(scheduled_time, insertion_order)`, and if
   its time is beyond the current virtual now, advance the clock and emit a
   `tick` record. Run the callback.
4. Repeat from 2 until the timer queue is empty or the timer budget (10 000
   callbacks) is exhausted.

`tick` records are in the trace, so the two programs must agree not only on
*what* their timers did but on *when* — a decompiler that turns `setTimeout(f,
10)` into `setTimeout(f, 20)` is caught even if nothing else observes the delay.

### 2.5 Infinite loops

A synchronous infinite loop cannot be interrupted from inside the process — no
timer will ever fire — so **each program runs in its own child process** and the
parent enforces a wall clock with `SIGKILL`. `vm.Script.runInContext`'s own
`timeout` option is a second, softer line of defence that catches the common
case without process teardown.

Both paths emit a `limit` record rather than an error, and that distinction
carries the whole weight of the design:

> Two different non-terminating programs both "fail" identically. If the timeout
> surfaced as an ordinary `err` record, the harness would compare two identical
> `Error: Script execution timed out` records and report EQUIVALENT. It is
> INCONCLUSIVE.

This was a real bug in the PoC, caught by the unit test that asserts it, and it
is the most likely way for a naive harness to report false green. Because the
child writes each record with `fs.writeSync` before continuing, the trace prefix
emitted before the kill survives — so "diverges, then hangs" is still correctly
reported DIVERGENT (`a divergence before a hang is still DIVERGENT`).

### 2.6 Programs with no observable output

Two empty programs trace identically. That is not evidence of anything, and a
harness that reports PASS for it is lying. The design has three answers, in
order of preference:

1. **A `globals` record.** After the run, the own properties the program added
   to the global object are encoded in sorted key order. A program that only
   defines `function f(){}` has *something* to compare.
2. **A `ret` record.** The completion value of the script — the value of its last
   expression statement — is often non-`undefined` and free to capture.
3. **Fuzzing** (§3), which turns "defines a function" into hundreds of
   observations.

If, after all three, the trace contains no *evidence* records at all, the
verdict is **INCONCLUSIVE**, never EQUIVALENT. `isEvidence` in `trace.mjs`
defines evidence as: any `out`, `err`, `unhandled`, `call`, `yield`, `hostset`
or `settle` record; a `ret` that is not `undefined`; a non-empty `globals`.

---

## 3. Oracle 2 — differential function fuzzing

After the main run, the harness enumerates the functions the program left on the
global object and calls each one with seeded argument tuples drawn from a corpus
chosen for where JS semantics fork: `-0`, `NaN`, `''`, `'0'`, `[]`, `{}`,
`Object.create(null)`, `{valueOf(){return 7}}`, `1n`, `Symbol()`, array-likes,
`Map`/`Set`/`RegExp`/`Date`/`Error`, functions. Systematic cases (no arguments,
all-`undefined`, arity+1) come first, then `N` seeded random tuples.

This is *differential*, not property-based in the fast-check sense: no
properties are asserted, only that both sides agree. That is the right shape
here — we have a reference implementation, so the specification is "whatever the
original does", and shrinking is unnecessary because the argument tuple is
already minimal and reproducible from the seed.

Returned generators are **driven**: an un-iterated generator object encodes
identically no matter what it would have yielded, so the harness steps it up to
8 times and records each `yield`.

**Measured value.** On the construct corpus, fuzzing raised the mutation kill
rate from 270/318 to 273/318. Small — because these fixtures already print
everything they compute. But the three mutants it killed are exactly the
interesting ones:

```
24-generator-return-throw [bump-numeric-literal]        2 -> 3
24-generator-return-throw [drop-statement]              yield 2; -> <removed>
26-infinite-generator-take [swap-adjacent-statements]   if (out.length >= count) break; / out.push(v);
```

All three are in generators the fixture only *partially consumes*. The fixture's
own output never reaches the mutated code; the harness's generator driver does.
That is the general lesson: **fuzzing pays off exactly where the fixture's
observable behaviour does not cover its own code**, which is the normal
situation for library-shaped code — and Tier 1 of `docs/TEST-CORPUS.md` includes
five real libraries (lodash, date-fns, marked, validator, qs) where it will
matter far more than it does here.

---

## 4. Oracle 3 — recompile round-trip (D3)

Decompile → `hermesc` → disassemble both → normalised diff. The only oracle that
scales to real RN bundles, because it never executes anything.

### 4.1 `hermesc -dump-bytecode` vs hermes-dec: which diff basis

**`hermesc -dump-bytecode`**, decisively:

- It is MIT (D4-clean), already fetched by `tools/get-hermesc.sh`, and available
  for every version we target.
- It is the *same compiler* that produced the bytecode, so its opcode naming and
  operand rendering are by definition correct for that version.
- hermes-dec is AGPL and may only be read as an oracle, never depended on; it
  also emits pseudo-instructions of its own (`SaveGenerator(...)`,
  `CatchBlockStart(...)`) that are its interpretation, not the file's contents.

The caveat is that `-dump-bytecode` takes **source**, not a `.hbc`. For the
decompiled side that is fine (we have source). For the original side we need
either `hbcdump` (only available for v84-era files) or our own disassembler —
which M2 is building anyway, and which this check then also exercises. So:

> The round-trip check is `hermesc -dump-bytecode <decompiled.js>` versus
> **our own disassembler's output for the original `.hbc`**, rendered in
> `hermesc`'s text format. Getting our disassembler to agree with
> `hermesc -dump-bytecode` on a recompile of a known source is a
> prerequisite M2 task, not an M3 one.

### 4.2 What normalisation is needed

Prototype: `tools/equiv/src/normalise-disasm.mjs`, driven by
`hbc2js-equiv normalise a.txt b.txt`. Determined empirically against real dumps:

| Feature | Treatment | Why |
|---|---|---|
| `Source hash:` | drop | hash of the source text; always differs |
| Header counts (`Function count`, `String count`, …) | drop | derived; differences show up in the body anyway |
| `Global String Table:` section | drop entirely | Hermes orders strings by kind then first use, so any reordering of the emitted code permutes it. The strings themselves already appear inline as instruction operands, so the table is redundant for a semantic diff |
| Everything from `Debug * table:` / `Textified callees table:` onward | drop | source paths, line and column numbers. **This one is easy to miss and dominates the diff if you do** — before dropping it, two identical programs in differently-named files differed by 20+ lines |
| `Offset in debug table:` | drop | debug-section offsets |
| Register numbers `rN` | rename by first appearance within each function → `%0`, `%1`, … | register allocation is a backend choice |
| Labels `LN` | renumber by first appearance → `@0`, `@1`, … | emission order |
| Inline-cache slot (the bare integer in `TryGetById r, r0, 1, "print"`) | mask to `#` | per-function counter assigned in emission order |
| Function names in `Function<name>(…)` | mask to `~` (keep `global`) | decompiled functions have generated names |
| `N registers, M symbols` in the function header | drop | allocator output |
| Parameter count | **keep** | genuinely semantic |
| Function order | keep by default; `sortFunctions` compares as a multiset | HBC function order follows source order of definitions |

### 4.3 Does it work? Measured

Three files in `tools/equiv/examples/`: an original using `for`/`let`/`+=`/`i++`
with meaningful names, a plausible decompiler rendering of the same bytecode
(generated local names, `while` instead of `for`, `var` instead of `let`, `+=`
expanded), and a second rendering identical to the first except that `_r2++` is
written `_r2 = _r2 + 1`.

```
raw `diff` of the two dumps                     79 lines
normalise original vs rt-decompiled-ok.js       EQUIVALENT (identical, 30 lines)
normalise original vs rt-decompiled-noisy.js    DIVERGENT (similarity 72.1%, 30 vs 31 lines)
                                                  - LoadConstZero    %3
                                                  + LoadConstUInt8   %3, 1
```

So the normaliser does its job precisely: **local variable names, `for` vs
`while`, `let` vs `var`, and compound-assignment sugar all vanish.** What
remains is genuine codegen difference — Hermes compiles `x++` to `Inc` and
`x = x + 1` to `LoadConstUInt8` + `Add`.

And that exposes the technique's real weakness. That one extra instruction needs
one extra register, which shifts *every subsequent register number*, which drags
the similarity from 100% to 72% for a one-token difference. **First-use register
renaming is a canonical form that is not robust to local edits.** Consequences:

- Use it as a **strict equality gate** (100% or investigate), not as a
  similarity threshold — a 72% score and a 5% score mean nothing comparable.
- Track it as a **ratchet**: percentage of *functions* whose normalised body
  matches exactly, which is monotone and does not smear a local difference
  across a whole function. droidsaw-hermes uses exactly this shape
  (`docs/PRIOR-ART.md` §2.6).
- A stronger canonical form — replacing register numbers with def-use / SSA
  numbering, so a register's identity is "defined by the 3rd instruction" rather
  than "the 5th register mentioned" — would be robust to insertion. Worth doing
  if the ratchet stalls; not worth doing first.

Two further prerequisites for using this at Tier 2 scale, both known from
`docs/TOOLCHAIN.md`: the recompile must use *the same Hermes build* (v99 has two
opcode tables without a version bump, and a different builtin table changes
`GetBuiltinClosure` operands), and the decompiled file must be compiled with a
matching filename because the name is embedded even without `-g`.

### 4.4 The complementarity, demonstrated

```
hbc2js-equiv rt-original.js rt-decompiled-ok.js        EQUIVALENT
hbc2js-equiv rt-original.js rt-decompiled-noisy.js     EQUIVALENT      <- execution
hbc2js-equiv normalise <dumps of the same two>         DIVERGENT (72%) <- round-trip
```

Execution is right and round-trip is wrong about *this* pair. On a pair that
differs only on an unexecuted path, it would be the other way round. Neither
subsumes the other; run both.

---

## 5. Oracle 4 — the Hermes VM as the executor

### 5.1 Availability: partial, and the limit is sharp

Determined by probing (not from documentation):

- Of the three package families `tools/get-hermesc.sh` uses, **only
  `hermes-engine-cli` ships a `hermes` interpreter**. `react-native` and
  `hermes-compiler` ship `hermesc` (the compiler) only. So the repo has exactly
  one VM: `tools/hermesc/v84/hermes`.
- **The Hermes VM refuses any bytecode whose version is not exactly its own:**
  ```
  $ tools/hermesc/v84/hermes -b tests/fixtures/hermes-dec-sample/v94.hbc
  Error deserializing bytecode: Wrong bytecode version. Expected 84 but got 94
  ```
- `hermes-engine-cli`'s **last published version is 0.12.0**, whose VM is
  **HBC 89** (verified by compiling with its own `hermesc` and reading offset 8).
  It also refuses v94.

**Conclusion: this oracle covers HBC ≤ 89 today and needs a source build of
Hermes (MIT, cmake) at the matching commit for v94 and v99.** That build is
worth doing — see §9 — but it is not free, and M3 must not be blocked on it.

Two further mechanical limits:
- **No prelude can be injected into a `-b` run.** Passing a `.js` and a `.hbc`
  together fails with `Multiple files must use CommonJS modules`. So the Hermes
  side cannot have `Math.random`/`Date.now` stubbed, and its trace is only what
  the program printed plus its terminating error. For fixtures authored to the
  `tests/fixtures/README.md` conventions (deterministic, `print`-only) that is
  exactly enough; for anything nondeterministic it is not.
- Bare Hermes has no `console`, no `setTimeout`, no DOM. `print` is the only
  output channel. That is already the fixture convention, which is why this
  works at all.

### 5.2 Why it matters anyway: Hermes and Node disagree about JavaScript

Running all 45 v84 construct fixtures' own `.hbc` under the v84 VM and comparing
against the Node sandbox trace: **41/45 agree**, and the 4 that do not are the
ones `tests/fixtures/README.md` documents:

| Fixture | Node (spec) | Hermes v84 |
|---|---|---|
| `18-closure-loop-let` | `let closures each see own i: 0,1,2` | `3,3,3` |
| `20-let-const-tdz` | `inner block TDZ caught: ReferenceError` | `outer` (no TDZ; inner `let` writes through to the outer binding) |
| `42-rest-params` | `non-strict arguments aliasing: mutated` | `original` |
| `49-arguments-object` | `changed-via-arguments` | `original` |

This PoC adds one data point the README flags as unverified: **the divergence is
not a v84 quirk.** Running the same sources under the HBC-89 VM from
`hermes-engine-cli@0.12.0` reproduces all three behaviours (per-iteration `let`
capture, TDZ, and `arguments` aliasing are all still missing). Pre-Static-Hermes
Hermes simply does not implement them.

The implication for the harness is not a footnote:

> `18-closure-loop-let` compiled by Hermes v84 produces bytecode with **one**
> binding for `i`. A *correct* decompiler must emit JavaScript that prints
> `3,3,3`, because that is what the bytecode does. Comparing that output against
> the original source's Node behaviour (`0,1,2`) reports DIVERGENT — and the
> decompiler was right.

So the reference trace has to come from the bytecode's own engine wherever one
exists. Where one does not (v94, v99, until someone builds Hermes), the harness
must **mark these constructs as known-divergent** and compare decompiled-vs-Node
only, accepting that a handful of fixtures test the decompiler against the wrong
reference. `docs/TEST-CORPUS.md`'s per-fixture metadata is the right place for
that flag.

---

## 6. Static / normalised-AST comparison — evaluated, not recommended

Parse both sides with acorn or `@babel/parser`, alpha-rename bound variables,
desugar (`+=` → `=` + binary, `for` → `while`, template literals → `+`),
constant-fold, sort commutative operands, and compare the resulting trees.

**Where it works.** Straight-line code, pure expressions, and shape checks:
"same number of functions", "same set of string literals", "same call graph".
Alpha-renaming genuinely solves the generated-names problem, which is the single
biggest source of noise for a decompiler.

**Where it fails — which is most of hbc2js's actual difficulty.** The
decompiler's output *differs structurally on purpose*. D7's structurer emits
labelled blocks and `while(true)` with multi-level `break` where the source had
a `for` with a `continue`; D6's fallback emits `for(;;) switch(ip)` where the
source had ordinary control flow; D9 emits `__hbc_makeGenerator(body, env)`
where the source had `function*`. No AST normalisation short of a full
equivalence prover relates `for(;;) switch(ip)` to the loop it emulates — that
is the same problem as decompiling, which is what we were trying to check.

It also cannot see anything the *runtime* does: prototype chains, coercion,
property order, exception propagation through `finally`.

**Verdict: not an oracle. A triage tool.** When an execution trace diverges at
record 47, an AST diff of the two functions involved is the fastest way to see
why. Build it if and when the debugging loop is painful; do not gate on it. It
also has a legitimate narrow use as a *cheap pre-filter* — "these two files have
different string-literal multisets" is a sound and instant DIVERGENT — but that
is a special case of §4, done worse.

---

## 7. What the literature offers

**Translation validation / SMT (Alive2, CompCert).** Alive2 proves LLVM IR
transformations correct by encoding both sides into SMT and asking for a
counterexample, with an explicit refinement relation for undefined behaviour;
CompCert instead proves the compiler once, in Coq, via simulation relations.
Neither transfers directly — JavaScript has no tractable SMT encoding
(prototype chains, dynamic property access, `Proxy`, string coercion), and
hbc2js's input is one *fixed* program, not a transformation to prove sound in
general. What transfers is two ideas we have adopted: (a) the verdict must be
three-valued, with "the solver gave up" distinct from "verified" — that is our
INCONCLUSIVE; and (b) a *refinement* relation, not equality, is the right
notion when one side is allowed to be more defined than the other (our
`--relax` flags are exactly a hand-rolled refinement relation, and should be
documented as such rather than as "leniency").

**How other decompilers actually test.** Java decompiler suites (Fernflower /
Vineflower, CFR, Procyon) overwhelmingly use **recompile-and-compare**: decompile
`.class` → recompile with `javac` → compare bytecode after normalising constant
pool order and local-variable slot numbers. Vineflower's test corpus is
single-construct files with committed expected-output, structurally identical to
`tests/fixtures/constructs/`. The wasm side (wasm2c, wasm-decompile) leans on
differential execution against the reference interpreter over the spec test
suite. Two lessons: the recompile round-trip with *constant-pool and
slot-number normalisation* is the field-standard workhorse — which is exactly
D3, and our string-table and register normalisation are the same two problems in
Hermes clothing; and nobody in either community relies on AST comparison. What
is missing from all of them, and where hbc2js can be better, is that almost none
combine the two oracles or report a three-valued verdict — a recompile
mismatch is triaged by a human, and a decompiler that emits code which compiles
to different-but-equivalent bytecode is scored as a failure.

---

## 8. Layered strategy

### Order (fastest failure first, per fixture)

```
0.  node --check decompiled.js                    syntax          ~30 ms
1.  execution trace vs reference                  D2              ~90 ms  (2 processes)
2.  + fuzzing of exported functions               D2'             +~30 ms
3.  recompile round-trip, normalised diff         D3             ~150 ms
```

Stop at the first DIVERGENT. Steps 1–2 share a single run of each program, so
they are one cost, not two.

### Which tier gets which oracle

| Tier | What it is | Oracles | Reference trace from |
|---|---|---|---|
| **1a** — `tests/fixtures/constructs/` (53) | single-construct, `print`-only, deterministic | 0,1,2,3 | **`.hbc` under Hermes** where a matching VM exists (v84 today); else `expected.txt` |
| **1b** — `hermes-dec-sample/` | multi-feature torture sample | 0,1,3 | Node sandbox (nondeterministic; see below) |
| **1c** — real MIT libraries (lodash, qs, …) | library-shaped, little top-level output | 0,1,**2**,3 | Node sandbox; fuzzing is the primary oracle here |
| **2** — RN/Expo app bundles | 1–12 MB, needs an RN host | 0,**3** | n/a — never executed |

Tier 1b deserves a warning. `tests/fixtures/hermes-dec-sample/source.js` is a
*poor* equivalence fixture despite being the historical one. Under the sandbox
its entire trace is:

```
hostset window.onload = [fn ze/0]
err main RangeError: Maximum call stack size exceeded
globals {gen: [fn gen/0], testx: [fn testx/1], ze: [fn ze/0]}
```

Three evidence records. `ze()` recurses unboundedly (its guard is
`if (Math.random())`, and a frozen `Date.now()` is truthy), so the stack
overflows at line 52 and roughly half the file — the regex, the BigInt
comment, both `console.log` calls — is never reached. It is a fine *parser*
fixture and a weak *behaviour* fixture. The construct corpus is the real Tier 1.

---

## 9. What the M3 harness spec must contain

Beyond what this PoC demonstrates:

1. **A normative trace-format document** with a version number in the `meta`
   record, so committed golden traces survive harness changes. `docs/TESTING.md`
   per D2.
2. **Reference-trace policy per fixture.** Machine-readable, per fixture and per
   HBC version: which engine produces the reference, and which constructs are
   known-divergent under which Hermes version (the four in §5.2, at minimum).
   Without this the harness reports 4 permanent false failures.
3. **The `--relax` set, justified as a refinement relation.** Which relaxations
   are legitimate for decompiler output (`fn-names` — names are erased by
   Hermes, per SPEC's out-of-scope list) and which mask real bugs (`key-order`
   masks a genuine emitter bug; `error-messages` masks bad message
   reconstruction). Default: `fn-names` on, everything else off.
4. **Golden-trace storage and update workflow.** Committed NDJSON per fixture,
   with an explicit `--update-goldens`, so trace changes are reviewed in diffs
   rather than silently re-baselined — the same discipline
   `tests/fixtures/README.md` already imposes on `expected.txt`.
5. **Mutation testing of the harness in CI.** A kill rate that *drops* means the
   harness got weaker. §10's numbers are the baseline.
6. **The Hermes source-build decision.** Building Hermes (MIT, cmake) at the
   v94 and v99 commits gives a matching VM and removes §5.2's whole problem
   class. Cost: a build per version, plus CI caching, plus the v99 commit is
   not public (`docs/TOOLCHAIN.md`) so v99 would use the closest public build.
   Recommendation: do it for v94, defer for v99.
7. **Round-trip ratchet mechanics.** Per-function match percentage, a committed
   baseline, and a CI gate that fails on regression rather than on absolute
   score.
8. **Budgets as first-class config.** Wall clock, record cap, timer budget,
   generator steps, fuzz cases — every one of these turns a PASS into an
   INCONCLUSIVE when hit, so they belong in the fixture metadata, not in code.
9. **A CI matrix over HBC versions**, since `docs/TEST-CORPUS.md` and
   `tests/fixtures/README.md` already establish that 15 of 153 fixture×version
   combinations do not compile at all.

## 10. CLI shape

```
hbc2js-equiv <a.js> <b.js>              compare two JS programs by execution trace
hbc2js-equiv --hbc <a.hbc> <b.js>       original bytecode vs decompiled JS, both under Hermes
hbc2js-equiv normalise <a.txt> <b.txt>  normalised disassembly diff (D3)

  --timeout <ms>      wall-clock budget per program (default 5000)
  --seed <n>          PRNG seed (default 0)
  --seeds <n>         re-run with seeds 0..n-1; any DIVERGENT wins
  --fuzz[=<n>]        differential fuzzing, <n> tuples per exported function (default 50)
  --relax <list>      fn-names, key-order, error-messages
  --engine node|hermes|auto
  --hermes <path>     explicit VM binary
  --trace-out <dir>   write both NDJSON traces for inspection
  --max-records <n>   trace cap (default 20000)
  --json              machine-readable verdict
  --quiet             verdict line only

exit 0 EQUIVALENT   1 DIVERGENT   2 INCONCLUSIVE   3 harness error
```

`--hbc` without a matching VM does not silently fall back; it reports
INCONCLUSIVE and names the versions that are available, because a silent
fallback to Node is precisely the §5.2 mistake.

A DIVERGENT report shows the first differing record with three records of
context on each side:

```
DIVERGENT — traces diverge at record 1

     0   hostset window.onload = [fn ze/0]
     1 - err main RangeError: Maximum call stack size exceeded
     1 + out console.log "null" ["null"]
     2 - globals {gen: [fn gen/0], testx: [fn testx/1], ze: [fn ze/0]}
     2 + out console.log "a [object Object]" ["\"a\"","{value: 42, done: false}"]
```

---

## 11. Results: the PoC against the whole corpus

`node tools/equiv/selftest.mjs --hermes --fuzz`, 53 fixtures, ~40 s wall clock
on an 8-core laptop (~45 ms per program run).

### Phase 1 — determinism and fidelity: 53/53

Every fixture executed twice in independent child processes traces identically
(this tests the sandbox's determinism, not merely reflexivity), and the `print`
projection of every trace equals the fixture's `expected.txt` byte for byte.

One trace-design lesson fell out of this. A `print` of a multi-line template
literal is *one* trace record but *several* lines of stdout, so the `print`
projection must be compared as joined text and re-split, never record-by-record
against an engine's line-oriented output. Comparing naively reported a phantom
divergence on `43-template-literals`.

### Phase 2 — mutation kill rate: 273/318 (85.8%)

Six mutants per fixture, generated by 12 operators, each validated with
`node --check`.

| Operator | Killed |
|---|---|
| `flip-equality` | 9/9 |
| `break-to-continue` | 6/6 |
| `continue-to-break` | 3/3 |
| `drop-finally` | 2/2 |
| `and-to-or` | 2/2 |
| `bump-numeric-literal` | 72/82 |
| `drop-statement` | 76/81 |
| `plus-to-minus` | 36/39 |
| `strip-await` | 5/6 |
| `flip-relational` | 18/27 |
| `swap-adjacent-statements` | 44/61 |

All 45 survivors were inspected. They fall into three classes, and **every one
examined is a genuine equivalent mutant, not a harness blind spot**:

- **26 × swapped independent statements** — `const a = …; const b = …` reordered,
  class field declarations reordered, two `print`s of values that are both
  `undefined` (`48-optional-chaining-nullish`), a `print` swapped with an
  unrelated `let` declaration (`47-typeof-instanceof-in`).
- **~12 × unreached code** — `i < 100` → `i <= 100` in a loop that always
  `break`s at `i = 17`; class field initialisers that the constructor
  immediately overwrites.
- **~7 × dead values** — `12-try-catch-finally-return` drops `return 'from-try'`
  and flips a `+` inside a `catch` whose return value a `finally` discards. Both
  are provably unobservable.

The equivalent-mutant problem is undecidable in general, so a 100% kill rate is
not the target; what matters is that the survivors are explicable. Two operators
were fixed during development because they were *not*: mutations that fired
inside comments and string literals produced trivially-equivalent mutants and
inflated the survivor count (the word "break" in a fixture's header comment).
`isCodeMask` now masks comments, strings, template literals and regex literals,
and a unit test pins that behaviour.

### Phase 3 — Hermes VM cross-check: 41/45

Exactly the four divergences of §5.2, matching `tests/fixtures/README.md`
independently.

### Unit tests: 19/19

`node --test 'tools/equiv/test/*.test.mjs'`, ~3 s. Covers the encoder's
edge cases, PRNG determinism, clock pinning, the INCONCLUSIVE paths (empty
program, infinite loop), divergence-before-hang, error comparison without
stacks, microtask interleaving, virtual timer ordering, unhandled rejections,
host writes, the mutation code mask, and the normaliser.

---

## 12. Risks: how two programs pass every check and still differ

Ordered by how likely each is to actually bite.

**R1 — Unexecuted code.** The trace only covers the path taken. A decompiler
that mis-structures an error branch nothing triggers, or a `switch` case no
input reaches, passes. *Mitigations:* fuzzing (§3) exactly for this; the
round-trip check (§4) sees all code whether executed or not; per-fixture
coverage measurement would quantify it and currently does not exist. **This is
the largest hole and the round-trip oracle is the only real answer.**

**R2 — Wrong reference semantics.** §5.2. Comparing decompiled v84 bytecode
against the original source's *Node* behaviour is comparing against the wrong
thing. Currently affects 4/45 known fixtures; unknown how many at v94/v99
because no VM exists to check. *Mitigation:* §9 item 2, and building Hermes.

**R3 — Budgets read as agreement.** Timeouts, record caps and timer budgets all
truncate a trace, and two truncated traces with equal prefixes look equal. The
`limit` record and the three-valued verdict handle this by construction; the
risk is a future contributor "simplifying" INCONCLUSIVE away. There is a unit
test guarding it. **Never allow a two-valued verdict.**

**R4 — Behaviour that leaves no trace.** Memory use, execution time,
stack depth, engine-internal shape transitions, and — importantly for a
decompiler — *performance* differences from `for(;;) switch(ip)` fallback code.
The tool is silent on all of it, by design. If output-bundle performance ever
becomes a requirement, it needs a separate oracle.

**R5 — Over-relaxation.** Every `--relax` flag deliberately blinds the checker.
`fn-names` is necessary and sound (names are erased by Hermes); `key-order`
masks a real emitter bug; `error-messages` masks bad message reconstruction.
A fixture that needs three relax flags to pass is not passing.

**R6 — Sandbox realm leakage.** The `node:vm` context is Node's realm with a
stubbed surface. `Intl`, `toLocaleString`, ICU collation, `Error.prepareStackTrace`,
`structuredClone`, TypedArray endianness and `RegExp` engine differences are all
Node's, not Hermes's, and none is pinned. Two programs can agree in the sandbox
and disagree in RN. *Mitigation:* the Hermes oracle (§5), where available;
otherwise, avoid locale-dependent APIs in fixtures — the current corpus does.

**R7 — Identity and aliasing.** The encoder gives objects first-encounter ids,
so it detects *shape* differences reliably but detects *sharing* differences
only when a cycle or a repeat encounter makes them visible within one encoded
value. Two programs where one returns the same array twice and the other
returns two equal arrays can encode identically. A decompiler that duplicates a
literal instead of sharing a reference would slip through.

**R8 — Ordering that is coincidentally stable.** Property enumeration order,
`Promise` resolution order under identical structure, and `for...in` over
prototype chains are all spec-determined *for a given engine*, so both sides
agree even if the decompiler introduced a construct whose order is only
accidentally the same. Running under two engines (Node and Hermes) is the
mitigation, which is another argument for §5.

**R9 — The mutation baseline is not a coverage measure.** An 85.8% kill rate on
*this* corpus says nothing about a decompiler bug class no operator models —
notably closure environment-slot mix-ups (hermes-dec's known failure,
`docs/PRIOR-ART.md`), `finally`-block duplication, and generator state-machine
resumption points. Those need targeted mutation operators before the number
means what it appears to mean.

---

## 13. Open questions

1. **Build Hermes from source for v94?** It removes R2 for the version the
   project cares most about. Cost is a cmake build per version in CI. The v99
   commit is not public, so v99 would use the closest public build and inherit
   `docs/TOOLCHAIN.md`'s two known compiler differences.
2. **Is `expected.txt` or the Hermes run the ground truth?** They disagree on 4
   fixtures today. This document argues Hermes; `tests/fixtures/README.md`
   currently treats `expected.txt` (Node) as the oracle. The two need to be
   reconciled explicitly, per fixture, before M4 starts using either.
3. **Should the harness measure coverage?** V8's coverage API would quantify R1
   directly and cheaply. It would also tell us how much fuzzing is enough.
4. **Def-use register numbering for §4.2?** More robust than first-use renaming,
   but it is real work and the ratchet may not need it.
5. **Where does the Tier 2 (RN bundle) round-trip actually stand?** Untested
   here — no bundle in the repo yet. The normaliser has only been exercised on
   30-line dumps, not 12 MB ones, and its whole-file string-table drop may be
   too coarse at that scale.
6. **How should `settle` records get populated?** The record kind is specified
   and the encoder marks promises with stable ids, but nothing currently
   instruments settlement. It needs either a `Promise` subclass installed in the
   sandbox or explicit instrumentation at trace boundaries; the former changes
   the very semantics under test.
