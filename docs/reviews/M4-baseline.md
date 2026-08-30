# Review: M4 baseline decompiler (commit ae2c2e5 and the src/cfg, src/structure, src/emit, src/runtime, src/decompile.ts, src/cli.ts it lands)

Reviewer: Claude Fable 5, 2026-08-30. Adversarial, review-only (no `src/**` edits).
Every number below was re-measured on this machine (Apple Silicon, Node 25.9,
7-worker pool); scripts lived in the session scratchpad and are described inline
so they can be re-created.

## Verdict: **FIX-THEN-MERGE**

The headline holds — 492/492 PASS under `syntax + trace`, 237/241 hardened,
all 40 `fuzz` divergences are error-message text — but the gate is blind to a
**wrong-handler bug that hits React Native's own `applyWithGuard`** (C1), and
the `hbc2js gate` command that the docs point at does not run the decompiler at
all (H1). Fix C1 and H1 before merging; the rest can queue.

## Findings by severity

### CRITICAL

**C1 — Exception regions with identical byte ranges are nested in inverted
priority; the `catch` is skipped and the exception goes to the `finally`
rethrow handler.**
`src/cfg/exceptions.ts:43` sorts regions by `(start asc, end desc, fileOrder asc)`
and step 7 (`:87-94`) only assigns a parent to a *strictly* contained region, so
two handlers with the same `[start, end)` become siblings in file order.
`src/structure/augment.ts:198-249` then inserts try-heads in that order
(outermost first), which makes the *earlier* table entry the *outer* JS `try`.
The Hermes VM does the opposite: `BCProviderBase::findCatchTargetOffset`
(lib/BCGen/HBC/BytecodeDataProvider.cpp, verified at the v96 pin 644c8be)
returns the **first** matching table entry, so for equal ranges the earlier
entry is the inner handler.

Reproduced against the Hermes VM at v84, v94 and v99 with a 10-line file
(`var inGuard=0; function applyWithGuard(fun,ctx,args){ try { inGuard++; return
fun.apply(ctx,args); } catch (e) { report(e); return null; } finally { inGuard--; } }`):
hermesc emits `.try T1..T2 -> L1` (catch) and `.try T1..T2 -> L2` (finally) with
identical ranges; the decompiled output prints `escaped boom` where the VM
prints `reportError boom`, at all three versions. The same shape appears with
`try { await … } catch {} finally {}` at v84/v94 (an async function's catch is
never entered).
Corpus impact: **0 gate fixtures** contain the shape (a scan over every gate
binary found none — that is why 492/492 is true), but
`bundles/rn-template-0.72/index.android.hbc` has it in **6 functions**,
including fn#66 `applyWithGuard` — React Native's `ErrorUtils` core — and
fn#474/2122 (identical ranges 50..132). Every RN app routes errors through
this function.
Fix (small): in `exceptions.ts` step 3 break ties by `fileOrder` **descending**
(later entry = outer), and in step 7 let an equal-range region with a *higher*
fileOrder be the parent of the lower one. `dispatchStructure`'s
depth-then-index ordering (`structure.ts:288`) then follows automatically.
Add a regression fixture (`54-try-catch-finally-shared-range`, the
`applyWithGuard` idiom, plus the async form) and a CFG invariant that for equal
ranges `parent` is set. Spec 03 §5 steps 3 and 7 need the same edit, with the
VM's first-match rule quoted as the reason.

### HIGH

**H1 — `hbc2js gate` never runs the decompiler.** `src/cli.ts:355`
`runTierCmd` calls `runTier({ tier, only, versions })` with no `decompiler`,
so the CLI gate scores the *identity* decompiler (`tiers.ts:36`). The real
492-check run exists only in `tests/sweep/decompile/sweep.test.ts` (T2), which
`npm test` does not execute — it needs `HBC2JS_TIER=sweep`/`test:all`. So the
per-commit gate (`npm test`, 67 s) contains no execution-equivalence check of
the decompiler; only `node --check` (T1) and the structurer's isomorphism check.
Fix: pass `decompile` (already imported in `cli.ts`) as the `decompiler` in
`runTierCmd` (keep `--identity` for the harness self-test), and move T2 into
`tests/gate/` — it costs 26 s (table below), well inside the budget.

**H2 — The Discord/Shopify story in STATUS is not reproducible with the shipped
CLI.** `hbc2js discord.hbc` (53 MB, 120,522 functions) dies with
`FATAL ERROR: … JavaScript heap out of memory` after ~30 s at 4.6 GB RSS under
Node's default heap. With `--max-old-space-size=16000` it fails at 10 s with
`E_ENV_UNRESOLVED: 4018 environment access(es) could not be resolved
statically` because `decompile()` hard-codes `strictEnv: true`
(`src/decompile.ts:63`) and the CLI exposes no flag. Only a script passing
`analysis: { strictEnv: false }` reaches the documented
`E_EMIT_UNSUPPORTED: JmpTypeOfIs mask 507` refusal (9.6 s, 4.9 GB RSS). Fix:
add `--lenient-env` (or make the sweep's `strictEnv: false` the CLI default for
bundles with a diagnostic count), document the heap requirement, and cut peak
memory — `analyseModule` appears to retain every function's decoded
instructions and CFG for the whole module; decoding lazily per function during
emit would bound it.

**H3 — Spec 05 §7.1 rule 4 is unmet: no helper has its own unit test or a
`docs/LOWERING-CATALOGUE.md` row.** `grep __hbc_ docs/LOWERING-CATALOGUE.md`
is empty; `tests/gate/emit/emit.test.ts` checks only that `helpersUsed` matches
what is emitted (EM-03). The 28 helpers in `src/runtime/helpers.ts` are tested
solely through whichever fixtures happen to reach them. D18 ("larger set")
records the count but not the missing tests. My own probes (below, item 5)
found the generator shim correct and the async shim wrong in one narrow way
(M1); a per-helper test file would have found C1's async form too.

### MEDIUM

**M1 — `__hbc_b_spawnAsync` does not reproduce Hermes's `await` timing for
thenables.** Hermes ≤96 calls a thenable's `then` synchronously inside `await`
(observed: `thenable.then` prints *before* `sync-end`); the shim's
`Promise.resolve(v).then(...)` defers it a tick, and microtask interleaving of
sibling async calls shifts by one tick. Only visible with custom thenables or
cross-function microtask ordering; `31-microtask-ordering` passes because it
does not interleave two async bodies. Record in `KNOWN_DIVERGENT_FIXTURES`-style
docs or make the driver mirror Hermes's InternalBytecode `spawnAsync`.

**M2 — `SelectObject` outside a `new` triple is lowered as `x instanceof Object`
(`src/emit/lower.ts:690`).** The VM tests "is an object", which differs for
`Object.create(null)` results and revoked/odd-prototype objects. Use
`(typeof x === "object" && x !== null) || typeof x === "function"`. Same
concern for the paired path if it ever reads the constructor's return this way.

**M3 — The structurer's isomorphism check cannot see C1.** `verify.ts` P1–P7
check normal edges only; exception edges "never enter" the check, and there is
no property relating JS `try` nesting to handler priority. Add P8: for every
pair of `try` nodes whose regions overlap, the one whose region has higher
priority (inner by range, or earlier in the table for equal ranges) must be
the inner node. My tree walk over 13,695 functions found 0 inversions *under
the current parent model* — which is exactly why a property is needed rather
than a scan.

**M4 — D18's `Frontend` boundary is nominal.** No `Frontend` type exists in
`src/`. The emitter reads `HbcModule` directly (`literals.ts:123,150`,
`function.ts` frame layout, `builtins.ts`) and every era switch
(`version >= 97`) lives in the emitter. Acceptable for the baseline, but say so
in DECISIONS. Also: **D18 is numbered twice** (multi-frontend architecture and
the helper-set decision) — renumber the second to D20.

**M5 — Fuzz oracle: all 40 divergences are error-message text; 0 hide a bug.**
Method: ran source and candidate with `fuzz: 50` through `runProgram`, rendered
every comparable record, masked three V8 message families (`<id> is not a
function`, `<expr> is not iterable…`, `Symbol value to a string|number`) and
diffed the full record lists: 40/40 (fixture, version, variant) pairs become
identical, at every record, not just the first. Two consequences: (a) the
`--relax error-messages` option does **not** mask these families (still 40
DIVERGENT with it), so it cannot serve as the M5 fuzz gate as-is — widen it;
(b) 30 of the 40 (the `is not a function` and `.reduce` families) disappear the
day calls are emitted as `o.m(…)`/`f(…)` instead of `Reflect.apply`, which is a
reason to schedule call-shape recovery early (see the M5 order below).

**M6 — Round-trip ratchet baseline (rn-template `index.android.hbc`, v94).**
Decompiled output recompiles with hermesc v94 (0.9 s) to 4227 functions vs
4199; matching normalised function bodies as a multiset (the harness's
by-index comparison is meaningless with the helper prelude and IIFE present —
fix `roundtrip.ts` to match by multiset or name): **872/4199 = 20.8 % exact**.
By original size: <16 B 344 exact / 411; 16–64 B 442/1640; 64–256 B 79/1597;
≥256 B **7/551**. Mismatches are dominated by `Reflect.apply` call shape,
`let rN` frames with `rX = rX` copies, `__pc` stores, `TryGetById` → `in`
guards and duplicated `finally` bodies. This is the M5 ratchet floor.

**M7 — Exception over-reach guard: argued unobservable, with one unasserted
premise.** The guard (`function.ts:350-368`) is sound because (a) `__pc` is the
first statement of every block (`function.ts:235`), before anything that can
throw; (b) the rethrow precedes the `__exc`/catch-register write, so a
non-owned exception clobbers nothing; (c) a rethrown exception lands in the next
enclosing JS `try`, which by dominator nesting is the next candidate region
(or escapes, correctly); (d) generator frame factories and nested functions
each own a `let __pc`. The premise that is *measured but not asserted*:
`[min, max]` of `region.bodyBlocks` equals the set (block ids are address
ordered and regions are byte ranges) — true for all 2,191 regions in the gate
corpus + two bundles (1,816 of 2,197 emitted `try`s over-reach, so the guard is
load-bearing). Add a CFG invariant or build the guard from the set. The only
counterexample class I could construct is C1, which is a priority error, not
over-reach.

**M8 — HBC-FORMAT §6.3 tag 6 at v≥97: implementer is right; the spec is
wrong.** Verified from bytes (`47-typeof-instanceof-in` v99 value buffer
`71 01000000 | 61 | 72 0a000000 14000000`: Integer 1, tag 6 with **no
payload**, Integer 10, 20; at v94 the same `{a:1, b:undefined}` is not
buffer-serialised at all — `PutNewOwnByIdShort`) and from Hermes source at
both vendored pins (`include/hermes/BCGen/SerializedLiteralGenerator.h` at
639e5d6 and 913d31a: `UndefinedTag = 6 << 4`, no `ByteStringTag`, with a TODO
about restoring it). Two extra facts the spec should carry: at the v99 pin,
tag 0 is `ValueNullOrKeyPrivateNameTag` — a null tag in a *key* buffer is a
private name (`literals.ts:135-138` currently throws `E_EMIT_UNSUPPORTED`,
which is the right loud behaviour); and the exact cut-over commit between
v96 and 639e5d6 was not pinned (the implementer's 0/162 vs 51/51 count is the
evidence for "≥97"). Spec edit: §6.3 row 6 → "v≤96 ByteString (1-byte string
id); v≥97 Undefined (no payload)"; strike "undefined has no tag" for v≥97.

### LOW

**L1** Printer indentation resets inside emitted function expressions and
generator frame factories (`17-closure-loop-var` v99 line 87; every v≤96
generator body), and `break L0; break;` dead statements after `break`.
**L2** The identity gate inside `npm test` reports `error: 16`
(`tiers.test.ts` "full gate identity run") and the test asserts only
`divergent === 0`; those 16 ERRORs are unexplained and should be either fixed
or asserted.
**L3** The method-call fast path (`lower.ts:205-222`) elides the `GetById`;
this is sound only because JS fetches the callee before evaluating arguments —
worth a comment, since the matcher does not stop at intervening side effects.
**L4** `hbc2js disasm` prints `.try T1..T2` headers but never places `T`
labels in the listing, which made C1 slower to diagnose.
**L5** `CreateThis` lowering reads `.prototype` and `new` reads it again
(observable only via a getter/Proxy on `prototype`).
**L6** `tools/hermes-vm/v99` cannot run async functions (`_makeAsyncIterator …
undefined is not a function`); `reference-policy.ts` already falls back to
`expected.txt` with a caveat, so v99 async fixtures are checked against Node,
not Hermes — D14 is silently weaker at v99 for 27/28/30/31.

## The nine measured spec corrections — judgment

| # | Correction | Verdict | Edit |
|---|---|---|---|
| 1 | Tag 6 = `undefined`, no payload, v≥97 | **Correct** (M8) | HBC-FORMAT §6.3, spec 05 §5 |
| 2 | Call-arg block at `frameSize-7` / `-8` | Accepted on measurement + the 9-arg cross-check; not independently re-derived from `StackFrameLayout` | spec 05 §4 state per era |
| 3 | `AddOwnPrivateBySym` = (object, value, symbol) | **Correct** (35 v99 brand checks pass vs VM) | vendored doc comment note + catalogue row |
| 4 | Rest param in `paramCount` only at v≤96 | **Correct**, `.length` observable, passes 84–99 | spec 05 §9 |
| 5 | `HermesInternal` supplied by prelude | **Correct** | spec 05 §7.3 |
| 6 | v≥97 values in `literalValueBuffer` | **Correct** | spec 05 §5 |
| 7 | Env-in-slot declared at holder; loop-created env gets per-iteration `let` | **Correct** and bytecode-driven, so consistent with D14 (18 still prints `3,3,3`) | spec 05 §6: "declare slots at the `Create*Environment` site's enclosing scope" |
| 8 | Module IIFE wrapper | **Correct** | spec 05 §9 |
| 9 | Loop wrapper outside the merge kids | **Correct** — Ramsey's `loop` wraps everything dominated by the header; spec 04 §4.2's pseudo-code put it in `nodeWithin`'s base case, which strands the latch outside the loop (62 gate functions fell to dispatch). | spec 04 §4.2: `doTree(h)` = `loop(label, nodeWithin(h, mergeKids, ctx ++ [LoopHeadedBy h]))` when `h` is a loop header |

Also: §7.5's `W_UNPAIRED_NEW` diagnostic instead of a stop — acceptable given
totality on 4k-function inputs, but fix M2 in the same place. §7.3's four-helper
list → D18: accepted, subject to H3.

## D14 semantics (item 4)

Read the emitted JS for 18/20/42/49 at v94 and ran it under Node against
`expected.txt` and against the Hermes VM trace (`hbc2js equiv --hbc`) at v84,
v94, v99: all twelve EQUIVALENT to the VM, and the Node run of the emitted code
prints Hermes's answers, not the spec's — `3,3,3` (one env slot, no
per-iteration binding), no TDZ throws, `arguments` unaliased (`original`,
`false`). Fixture 18's emitted loop has `_e0_0` declared at function top
because the environment is created outside the loop; fixture 17 v99 gets a
`let _e0_0` *inside* the loop because there the bytecode creates the
environment inside it — the rule is the bytecode's, as it should be.

## Generator / async shims (item 5)

Hand-written probes compiled with hermesc at v84, v94, v99 and compared to the
matching VM: generators with `yield` inside `try/finally`, early `.return()`
(finally runs and yields), `.throw()` into a suspended and into a fresh
generator, catch-and-continue, re-entrancy (`TypeError`), and `yield*` with
`.return()` propagation — **28/28 trace lines match at all three versions**.
The v≤96 protocol gets its `.return()`/`.throw()`-on-fresh semantics from the
compiler's own leading `ResumeGenerator`, so the shim needs no special case.
Async: the rejected-`await`-inside-`try/catch/finally` probe **diverges at
v84/v94** — that is C1, not the shim — and the thenable timing is M1. The
prelude really is the only runtime dependency of emitted code: `scope-check.ts`
rejects any identifier not declared by the emitter or in its `KNOWN_GLOBALS`
list, and the helpers reference only each other.

## Robustness at scale (item 6)

| Bundle | Result |
|---|---|
| Bloomberg v96, 10.5 MB, 58,932 fns | CLI OK: **16.5 s wall, 3.4 GB RSS**, 83 MB output, `node --check` passes |
| Discord v98, 53 MB, 120,522 fns | CLI: heap OOM (~30 s, 4.6 GB); 16 GB heap: `E_ENV_UNRESOLVED` (4018); lenient script: `JmpTypeOfIs mask 507` at 9.6 s, 4.9 GB RSS (H2) |

`Typeof.h` is at `include/hermes/FrontEndDefs/Typeof.h` (verified at the
hbc98-late pin 639e5d6). `TypeOfIsTypes` is a `uint16_t` bitset in declaration
order: bit0 Undefined, bit1 Object, bit2 String, bit3 Symbol, bit4 Boolean,
bit5 Number, bit6 Bigint, bit7 Function (=128, matching the one confirmed
case), bit8 Null. There is no "Not" flag; negation is the complement, so mask
507 = 0b111111011 = everything except String, i.e. `typeof x !== "string"`.
The next brief needs: vendor `Typeof.h` under `third_party/hermes/<pin>/`
with a `VENDOR.yml` hash (same for the hbc99 pins, checking the enum is
unchanged), generate a per-table constant, and lower `JmpTypeOfIs r, mask` as a
disjunction over set bits (`Object` = `typeof v === "object" && v !== null`,
`Null` = `v === null`, `Function` = `typeof v === "function"`, the rest their
`typeof` string) — plus the same for `TypeOfIs` at `lower.ts:357`. Add a v98
fixture whose `typeof x !== "string"` / `=== "object"` tests produce non-128
masks so the table is exercised.

## Code quality (item 7)

No `.bind` anywhere in `src/emit` or `src/runtime` (EM-04 test also enforces
it). No silent decode fallbacks found in the emitter: unknown opcodes, bad
shape indices and unverified `TypeOfIs` masks all raise `E_EMIT_UNSUPPORTED`;
`readValuesTolerant` returns `null` for an out-of-range string id and that
prints `undefined` (`literals.ts:106`) — the one place a wrong decode would be
silent; it should at least emit a diagnostic. Test gaps: H3 (helpers), C1's
shape, M3 (try priority), the `[min,max]` premise (M7), per-opcode goldens for
the era switches (frame offset, `paramCount`, `literalValueBuffer`).

## Timing table

| Run | Wall | Notes |
|---|---|---|
| `npm test` (gate, 759 tests) | **67.5 s** (user 343 s) | slowest: 7.B hbc-disassembler diff 63 s (serial subprocesses), identity gate 35 s, T1 `node --check` 33 s (one `node` spawn per binary), 2000 mutants 22 s |
| `npm run test:all` (777 tests, 775 pass, 2 skipped) | **108 s** (user 608 s) | under 2 min, but only just |
| Real decompiler gate, `syntax+trace`, 492 checks | **25.8 s** total (v84 4.6, v94 5.0, v96 5.1, v98 5.2, v99 5.9) | `runTier` with 7 workers |
| Same + `fuzz` | 24.8 s | 452 PASS / 40 DIVERGENT / 0 ERROR |
| Hardened tier, 241 checks | 14.2 s | 237 / 4 / 0, the four documented v99 `.obf` class fixtures |
| `hbc2js gate` as shipped (identity) | 35.3 s | see H1 |
| rn-template decompile / hermesc recompile | 0.58 s / 0.92 s | 6.65 MB output |

Neither `test:all` nor the real gate exceeds 2 min, so no concurrency change is
*required*; the cheap wins if the gate grows: (1) T1 should compile with
`new vm.Script(code)` in-process instead of spawning `node --check` per binary
(~30 s → ~2 s); (2) 7.B's disassembler diff should use the same worker pool
`runTier` has; (3) run `node --test --test-concurrency=<cpus-1>` — the suite is
file-serial today. Do those before adding T2 to the gate (H1) and the gate stays
near a minute.

## Recommended order for the first five M5 passes

Chosen by what the output actually looks like (02, 12, 17, 18, 23, 27 read in
full) and by what each pass unblocks in the oracles:

1. **Copy propagation / register-to-expression inlining** — `r3 = "sum="; r3 =
   r3 + r9; r3 = Reflect.apply(...)` chains are most of every function; this is
   the single largest readability and round-trip win and every later matcher
   wants expressions, not registers.
2. **Call-shape recovery** — `Reflect.apply(f, undefined, [a])` → `f(a)`,
   `rO.m(...)` everywhere the fast path could not prove elision; this also
   erases 30 of the 40 fuzz divergences and lets `fuzz` join the gate.
3. **Global-access recovery** — `TryGetById` + `if (!("print" in r0)) throw
   ReferenceError` + `DeclareGlobalVar` scaffolding → bare identifiers; it is in
   every function and blocks nothing else.
4. **Loop shape** (`while(c)`, `for`, `do…while` from the labelled
   `while(true)` + `break`/`continue`) — fixtures 02–04, 11; depends on 1 for a
   readable condition.
5. **`finally` dedup / try shape** — after C1 lands and P8 exists, since it
   rewrites exactly the structure C1 got wrong.

`yield` recovery (D9 v2) stays after these: the shim is correct and the state
machine is readable once 1–3 have run.
