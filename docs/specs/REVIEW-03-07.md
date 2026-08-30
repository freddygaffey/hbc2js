# Adversarial review — specs 03 (CFG), 04 (structurer), 05 (emitter), 06 (harness), 07 (pass ladder)

**Reviewer:** Sonnet, step 1b of `docs/AGENT-WORKFLOW.md`, reviewing as the Opus
agent about to implement M4/M5. Research/review only — no source touched, no
spec edited, `src/**`/`tools/**`/`tests/fixtures/**` untouched.

**Method.** Read all five specs against `docs/HBC-FORMAT.md`, `docs/PRIOR-ART.md`,
`docs/EQUIVALENCE.md`, `docs/DECISIONS.md`, `docs/AGENT-LOG.md` and
`docs/specs/REVIEW-01-02.md` (the prior review, for the expected standard). Ran
`hermesc -dump-bytecode -pretty-disassemble=false` at v84/v94/v98/v99 against
real construct fixtures (generators 23–26, try/finally 12–16, switch 09/10/52/53,
closures, for-in/for-of, `new`-using fixtures) and cross-checked every structural
claim in specs 03/05 against the actual bytes rather than trusting the prose.
Wrote a throwaway ~150-line Ramsey-structurer prototype
(`/private/tmp/.../scratchpad/ramsey-proto.mjs`, not part of this repo) and ran
it against a hand-built classic irreducible 2-entry loop, a hand-built flattened
loop+switch dispatcher, and a hand-built CFG shaped exactly like a real v94
generator body, to test spec 04's algorithm description and spec 03's CFG
construction rules for gaps. Read `tools/equiv/**`'s real file layout against
spec 06 §1's promotion table, and checked spec 07's declared pass-ordering
constraints for cycles.

**Counts: 2 blocker, 6 should-fix, 3 nit.**

---

## Blockers

### B1 — v≤96 generator resume-point blocks are unreachable in the CFG as spec 03 constructs it; this breaks CFG-10, the dominator tree, Ramsey structuring and the D9 shim for essentially every real generator

**Sections:** 03 §3.4, §4.1 rule 7, §4.2, §4.4, CFG-05, CFG-10; 04 §4.1 (dominators
required for everything); 05 §7.2 (the shim assumes "structured normally").

**Evidence.** `hermesc -dump-bytecode -pretty-disassemble=false` on
`tests/fixtures/constructs/23-generator-basic/source.js` at v94, function
`?anon_0_sequence` (the real generator body, found via `CreateGeneratorClosure`
→ trampoline `NCFunction<sequence>` → its own `CreateGenerator 0,0,2` → this
function):

```
[@ 0]  StartGenerator
[@ 1]  ResumeGenerator 0<Reg8>, 1<Reg8>
[@ 4]  JmpTrue 82<Addr8>, 1<Reg8>
[@ 7]  LoadConstString 1<Reg8>, 7<UInt16>
[@ 11] SaveGenerator 4<Addr8>          -- target = 11+4 = 15
[@ 13] Ret 1<Reg8>
[@ 15] ResumeGenerator 1<Reg8>, 2<Reg8>   <-- the resume block
[@ 18] JmpTrue 65<Addr8>, 2<Reg8>
...
```

Per spec 03 §4.1 rule 7, offset 15 is a leader (correct — `SaveGenerator`'s
target). Per §4.2's edge table, the block `[7,15)` (`LoadConstString;
SaveGenerator; Ret`) ends in `Ret`, whose row is `return | none` — **zero
outgoing edges**. Nothing else in the function jumps to offset 15 either: I
grepped every `JmpTrue`/`Jmp` target in the full function body and none is 15
(the only way to reach 15 from a second `.next()` call is the VM re-invoking
`StartGenerator`, which internally fast-forwards to the saved pc — this is
**opaque VM state**, not a static edge in the bytecode). So block-at-15 has
**zero predecessors** in the graph spec 03 builds.

I confirmed this is real, not an artifact of one fixture, with a synthetic CFG
matching the shape exactly (`ramsey-proto.mjs` TEST 3): of 5 blocks built with
the same "one `Ret`-terminated yield block, one `ResumeGenerator`-headed
follow-up block with no incoming edge" shape, DFS-based reachability from entry
finds only 3/5 reachable; blocks 2 and 3 (the resume points) are **structurally
unreachable**, exactly as in the real bytecode.

**Consequences, each independently checkable against the spec text:**

1. RPO (§4.4, computed by DFS from entry) never visits the resume blocks.
2. Dominators (Cooper–Harvey–Kennedy over RPO) never assign them an `idom`.
3. **CFG-10** ("`idom[entry] === null` and every other block has a non-null
   idom") is violated for every block that is a `SaveGenerator` resume target
   past the first `yield` — this is `E_INTERNAL`, fatal, for every construct
   fixture with more than one `yield` (23, 24, 25, 26 all qualify — I checked
   `23-generator-basic`'s `sequence` has 4 save points).
4. Even if CFG-10 were relaxed, spec 04's Ramsey structurer (§4.1: "the
   dominator tree... `rpo`... a block is a loop header iff target of a back
   edge") has no path to ever visit an unreached node, so the resume block's
   code (which is exactly the code that runs on the *next* `.next()` call) is
   never emitted — not "ugly," **absent**.
5. CFG-05's own framing actively hides this: *"dead code after `Ret` is normal
   (a handler unreachable both ways is suspicious)"* is exactly the wrong
   intuition for a generator body, where "dead code after `Ret`" is the single
   most important code in the function.

This directly blocks spec 03's acceptance criterion ("`analyseModule` succeeds
on all gate binaries with zero errors") and spec 05's M4 gate ("every gate
fixture emits JS that... is PASS under the equivalence checker") for every
v84/v94 (and presumably v98-early, if that layout is ever exercised) generator
fixture with more than one yield point — which is the normal case, not an edge
case. The v≥97 "lowered" era does **not** have this problem: I checked
`Function<sequence>` at v99 and confirmed every dispatch-chain case is reached
by an ordinary `JStrictEqual`/`JmpTrue` branch from the function's single entry
— genuinely "an ordinary function with a compare-chain," as spec 03 §3.4
claims. The bug is specific to the opcode-driven (v≤96) era.

**Fix.** Spec 03 must model a v≤96 generator body as having one *logical* entry
per `(StartGenerator-entry, every SaveGenerator target)` — structurally the same
problem spec 04 §4.4 already solves for irreducible multi-entry regions. Two
concrete options, either is fine, but one must be chosen and specified:
(a) add a synthetic edge from the function's entry to every `SaveGenerator`
target block (making the whole body a multi-entry region that Ramsey's
`dispatch` mode fronts with a `switch` on resume state — which is, not
coincidentally, exactly what the VM does at runtime), or (b) treat each
resume block as its own structuring root and stitch the results together at
emit time using `GeneratorShape.suspendPoints`. Either way, CFG-05's framing
needs a carve-out: unreachable-after-`Ret` is only "normal" when the function is
**not** `era: "opcode"` generator/async; for that era it must be a hard error,
not a diagnostic, because it means the emitted shim body will silently miss
resume code.

---

### B2 — `CreateThis`/`CreateThisForNew` and `SelectObject` (the real shape of `new`) have no lowering rule anywhere in spec 05, and they appear in roughly a quarter of the gate corpus

**Sections:** 05 §3 (naming table), §4 (statement lowering table), §7.4 (calls —
"Construct" row).

**Evidence.** Spec 05 §7.4 says: *"Construct. `new r<callee>(…)` for
`Construct`/`CallWithNewTarget`."* That is the **only** sentence in the entire
spec about lowering a constructor call, and it is incomplete: `hermesc` never
emits a bare `Construct` for `new X(...)`. It always emits a three-instruction
idiom, verified at both v94 and v99 on `tests/fixtures/constructs/13-try-finally-no-catch/source.js`
(`new Error('propagated')`):

v94:
```
[@ 19] TryGetById 2<Reg8>, 0<Reg8>, 2<UInt8>, 9<UInt16>   ; global Error
[@ 25] GetByIdShort 0<Reg8>, 2<Reg8>, 3<UInt8>, 13<UInt8> ; Error.prototype
[@ 30] CreateThis 1<Reg8>, 0<Reg8>, 2<Reg8>               ; r1 = new-target-shaped `this`
[@ 34] LoadConstString 4<Reg8>, 6<UInt16>                 ; 'propagated'
[@ 38] Mov 5<Reg8>, 1<Reg8>                               ; thisArg slot <- r1
[@ 41] Construct 0<Reg8>, 2<Reg8>, 2<UInt8>                ; r0 = call ctor(this=r1,'propagated')
[@ 45] SelectObject 0<Reg8>, 1<Reg8>, 0<Reg8>              ; r0 = isObject(r0) ? r0 : r1
[@ 49] Throw 0<Reg8>
```
v99 is the same shape with `CreateThisForNew` in place of `CreateThis`.

`CreateThis`/`CreateThisForNew` allocate `this` from the callee's `.prototype`
**before** the call; `SelectObject` implements the spec rule "if the
constructor returns an object use that, else use the allocated `this`" **after**
the call. Neither opcode has any JS expression form on its own — you cannot
lower `CreateThis` as an isolated statement the way spec 05 §4's "one IR node →
one JS construct, mechanically" / "block: the block's instructions, lowered one
per statement" model assumes for everything else. This is structurally the
same problem the method-call fast path already solves for `GetById`+`Call`
(§7.4's first bullet) — a **multi-instruction pattern** that must be recognised
as a unit and collapsed to `new r<callee>(args)` — but spec 05 states that
pattern only for the call case, never for `CreateThis`/`SelectObject`, and
neither opcode appears in §3's naming table, §4's statement table, or anywhere
else in the document. Per **EM-05** ("every opcode encountered has a lowering;
unknown → `E_EMIT_UNSUPPORTED` naming it"), an implementation following the
spec literally throws on the very first `new` in the corpus.

**Scope, measured:** `grep -l "new Error\|new Array\|new RegExp\|new Map\|new Set\|new Date"`
over the 53 construct fixtures' `source.js` matches 11 files, and a direct
`CreateThis` count over the v94 `-dump-bytecode` output of all 53 fixtures
matches **12/53 (23%)** — `05-for-in-object`, `07-for-of-iterable`, all five
`try`/`catch` fixtures (12–16), `24-generator-return-throw`,
`28-async-await-error`, `29-promise-chaining`, `47-typeof-instanceof-in`,
`50-this-binding` — via plain `new Error(...)`/`new Promise(...)` in idiomatic
code, not contrived cases. This blocks the M4 gate on nearly a quarter of the
corpus at every version.

**Fix.** Add a `CreateThis`/`CreateThisForNew` + `Construct` + `SelectObject`
pattern to §7.4 with the same precision as the method-call fast path: recognise
the triple (this-alloc → construct-call whose `thisArg` register was produced
by that this-alloc → `SelectObject` combining the same two registers) and emit
`new r<callee>(args)` for it, never touching `CreateThis`/`SelectObject`
individually. Name both opcodes in §3's table (they need no dedicated
identifier, but they need an entry saying "consumed by the `new` pattern,
never lowered standalone") and add a negative case to EM-05's test ("a
`CreateThis` reached outside the expected triple is `E_EMIT_UNSUPPORTED`, not a
crash").

---

## Should-fix

### S1 — Spec 04 §4.2's `doBranch` pseudocode never states the actual trigger for invoking §4.4's irreducibility handling

**Sections:** 04 §4.2, §4.4.

The given pseudocode is: *"back edge → `continue`; `to` is a merge point →
`break`; else → `doTree(to)`"*. Nothing in it says what happens when `to` **is**
classified as a merge point (per §4.1's own definition: "≥2 normal predecessors
and not a loop header") but `labelOf(to)` is **not actually in scope** at this
call site — which is precisely what makes a region irreducible, and precisely
the case §4.4 exists for. I built a minimal irreducible graph
(`entry→A,B; A→B; B→A`) in `ramsey-proto.mjs` and ran a direct transcription of
§4.2's algorithm against it: node `A` and node `B` **both** satisfy the
official merge-point definition (2 preds each) and both are dominator-children
of `entry`, so per spec 04's ordering rule they get nested as `labeled` blocks
by descending RPO index — but the edge `A→B` runs from the **outer** (later-RPO)
label into the **inner** (earlier-RPO) one, which the given pseudocode's
unconditional `break(labelOf(to))` cannot resolve (the label for the inner
kid is not yet in the context available to the outer kid's own body). This is
exactly the "two or more blocks entered from outside" case, but the pseudocode
as transcribed gives no signal to switch into duplicate/dispatch mode — it
just silently has no such branch. Spec 04 §10 already tells the implementer to
"read the paper" for exactly this kind of gap, which softens it to should-fix
rather than blocker, but the acceptance criteria (T4) require exactly this case
to work, and the spec's own paraphrase omits the one line that matters most.

**Fix.** Add an explicit clause: `else if labelOf(to) is not found in
context → invoke §4.4 (irreducible)`, and say plainly that "is a merge point"
(§4.1's static property) and "has an in-scope label at this call site"
(§4.2's runtime property, which is what actually gates `break`) are different
tests — an implementer who conflates them (as the literal pseudocode invites)
ships a structurer that throws or infinite-loops on the first irreducible
region it meets, rather than falling back cleanly.

### S2 — Spec 03's `innerFunctionIndex` doc-comment is ambiguous for v≤96 in exactly the way that would misresolve `GeneratorShape`

**Section:** 03 §3.4 (`FunctionKindInfo.innerFunctionIndex`).

The field comment reads: *"v<=96: the outer stub's inner function; v>=97:
`CreateGenerator`'s operand."* This phrasing gives v≥97 an operational
definition (read an operand) but gives v≤96 only a description of the
*result* ("the inner function"), not the *procedure* to find it. I confirmed
by dumping `23-generator-basic` and `hermes-dec-sample` at v94 that the
v≤96 procedure is **exactly the same two-hop lookup** as v≥97: the top-level
`CreateGeneratorClosure`/`CreateAsyncClosure` operand (e.g. `fn#3` for
`counter`) names a **trampoline** function (`NCFunction<counter>`, `flags`
`prohibitInvoke:construct`, 1 register, body = `CreateEnvironment; CreateGenerator dst,env,fn#4; Ret`),
and only the trampoline's *own* `CreateGenerator` operand (`fn#4`,
`?anon_0_counter`) names the function that actually contains
`StartGenerator`/`SaveGenerator`. This is universal across both fixtures I
checked (`sequence`/`counter` in `23-generator-basic`, `gen` in
`hermes-dec-sample`, all show the same trampoline shape). An implementer who
reads "the outer stub's inner function" as "the `CreateGeneratorClosure`
operand itself" (the natural reading, since that operand *is* called
"the... function" elsewhere in the same fixture) will find a trampoline
function with **zero** `SaveGenerator` instructions, and `GeneratorShape.suspendPoints`
will silently come back empty for every v≤96 generator — not a crash, a
quietly wrong classification that only surfaces later, e.g. as an unexplained
"never called `__hbc_makeGenerator`" bug.

**Fix.** State the two-hop procedure explicitly and identically for both eras:
"follow the creation-site opcode's function-id operand; if that function's
*own* body contains a `CreateGenerator`, follow *that* operand instead — this
is the common case for v≤96 generators that take parameters or otherwise need
an environment before instantiation; only when there is no second-level
`CreateGenerator` is the creation-site operand itself the inner function."

### S3 — Spec 05's shim-routing rule for `CreateGeneratorClosure` at v≤96 has no operand-level lowering rule, unlike the v≥97 `CreateGenerator` rule

**Section:** 05 §7.2.

§7.2 gives a precise emission rule for `CreateGenerator` ("Emit `CreateGenerator dst, env, innerFnId` as `r<dst> = __hbc_makeGenerator(_fn<innerFnId>, <env expr>)`") but for v≤96 only says, in prose, that "M4 emits the v≤96 generator body through the same shim" without ever stating what `CreateGeneratorClosure dst, env, fnId` itself lowers to. Given S2's finding — that `fnId` here names a **trampoline**, not the shim-wrappable body — a literal reading of "route it through the same shim" is actually ambiguous between two different, both-plausible emissions: (a) lower `CreateGeneratorClosure` as an ordinary closure creation and let the *trampoline's own* `CreateGenerator` instruction (inside the trampoline function, which gets structured normally) do the shim-wrapping via the already-stated rule, or (b) special-case `CreateGeneratorClosure` itself to skip the trampoline and directly emit `__hbc_makeGenerator(_fn<trueBodyId>, env)`, deleting the trampoline entirely. These produce different call-arity/register shapes and only one of them is consistent with "the M4 baseline is a mechanical per-opcode lowering, not pattern recognition" (§4). Pick (a) — it requires zero new pattern recognition, which is exactly M4's stated bar — and say so explicitly, because right now an implementer has to reverse-engineer S2's finding first to even see the ambiguity exists.

### S4 — Specs 05 O-2 and 06 O-1 present "measure v94/v99 Hermes-vs-Node divergence" as an open, unmeasured question; `docs/AGENT-LOG.md` already answered it

**Sections:** 05 §14 O-2; 06 §4 ("Open measurement"), §14 O-1.

Both specs say, verbatim or near it, "nobody has measured whether v94/v99 still
diverge" and treat it as a ~20-minute task someone should do before the gate can
rely on the reference-policy table for those versions. But `docs/AGENT-LOG.md`'s
entry for the Hermes-VM-from-source task (the one that built
`tools/hermes-vm/v{94,99}/bin/hermes`, same day) already did exactly this: *"Ran
10 `tests/fixtures/constructs/*` fixtures (incl. the 4 known-divergent ones)
under both new VMs against `expected.txt`... D14's 4 known Node-vs-Hermes
divergences (`18-closure-loop-let`, `20-let-const-tdz`, `42-rest-params`,
`49-arguments-object`) persist unchanged at v94 and v99."* This is the exact
measurement both specs ask for, sitting in the project's own log, undated
relative to spec 05/06's writing only by the fact that they're products of a
concurrent-agent workflow (the same staleness pattern `docs/specs/REVIEW-01-02.md`'s
B3 flagged for specs 01/02 against the fixture corpus). As written, spec 06's
`HA-06` ("the reference policy fails loudly on an unmeasured `(fixture,
version)` pair") would make the gate throw for every v94/v99 fixture touching
these four constructs, blocking M4's own acceptance criteria (05 §12: "The four
EQUIVALENCE §5.2 divergences PASS against their matching VM") for no reason —
the data to populate the table already exists.

**Fix.** Fold the AGENT-LOG measurement directly into
`src/harness/reference-policy.ts`'s data (spec 06 §4): extend the
known-divergence table's four rows to cover v94 and v99 with the same verdicts,
citing the AGENT-LOG entry, and drop O-2/O-1 as resolved rather than open.

### S5 — Spec 07 §4 lists the `for…in`/`for…of` opcode families as unverified "hard block[s]" for two of the first ten passes; both are confirmed by a one-line `hermesc` command

**Section:** 07 §4, §6 (passes 7 and 8).

§4's evidence table lists `for…in` and `for…of` under "Must be measured before
any pass is written (all ⛔ today)" and §6 marks passes 7 (`for-in`) and 8
(`for-of`) "yes, hard block — the opcode family has not been verified in this
repo at all" / "same." I ran
`hermesc -dump-bytecode -pretty-disassemble=false tests/fixtures/constructs/05-for-in-object/source.js`
and the equivalent for `06-for-of-array`, at both v94 and v99, and both
families are exactly as PRIOR-ART §6 predicted and trivially confirmable:

```
for…in (v94 and v99): GetPNameList dst,obj,idx,size ; GetNextPName name,list,obj,idx,size
for…of (v94 and v99): IteratorBegin it,obj ; IteratorNext val,it,obj ; IteratorClose it,flag
```

This is not a deep research task — it is the same one-command check spec 07
itself prescribes in §7 step 1 ("read the bytecode... at every version the
fixture compiles at"), and it was available before spec 07 was written (the
fixtures and hermesc binaries already existed). Blocking two of the ten
launch passes on a "hard block" that a single command resolves overstates T3's
remaining scope and would cause an implementer to skip work that is actually
ready.

**Fix.** Move `for-in`/`for-of` from "must be measured" to the confirmed table
with the excerpt above, flip passes 7/8's T3 column to "no — confirmed", and
narrow T3's genuinely-open scope (destructuring, spread, classes, optional
chaining, the v≥97 generator calling convention, `finally` shape) accordingly.

### S6 — CFG-12's invariant doesn't account for the trampoline pattern's `CreateGenerator` at v≤96 without care in how it's read

**Section:** 03 §7, CFG-12: *"`era === "opcode"` ⟹ zero `Create{Generator,Async}Closure`
in a v≥97 module, and vice versa."*

This invariant only names `CreateGeneratorClosure`/`CreateAsyncClosure`, not
`CreateGenerator` — which is good, because (per B1/S2's evidence) `CreateGenerator`
itself is used at **both** eras (inside the v≤96 trampoline, and as the
outer-stub-to-body link at v≥97). The invariant as literally written is
therefore correct, but nothing in spec 03 says so explicitly, and a reader who
assumes (reasonably, from PRIOR-ART's "v≥97: environments become explicit...
`CreateGenerator`" framing) that `CreateGenerator` is v≥97-only could
"tighten" this invariant incorrectly during implementation and produce a false
`E_INTERNAL` on every v≤96 generator with a parameter. Worth one sentence
making the shared-opcode fact explicit, next to CFG-12.

---

## Nits

### N1 — Spec 07's "first ten passes" table numbers stage-B passes 1–2 ahead of stage-A passes 3–10, which reads as runtime order but isn't

**Section:** 07 §6, §5 constraint 1.

Table rows are numbered 1 (`expr-rebuild`, stage B) and 2 (`call-shape`, stage
B) before 3–10 (stage A). §5 constraint 1 ("stage A entirely before stage B")
and the note under the table ("`expr-rebuild` is number 1 despite
`01-if-else-chain` being the first fixture... this is the 'unless a dependency
forces otherwise' clause") together resolve the apparent contradiction, but
only for pass 1 — pass 2 (`call-shape`, also stage B) gets no equivalent note,
and a reader skimming the table alone (which is the artifact most likely to be
skimmed) could reasonably conclude passes run in table order. A one-line
caption ("this table is implementation/session order, not registry/runtime
order — runtime order is fixed by stage and by `after`/`before`, §5") would
remove the ambiguity for both passes at once.

### N2 — The implicit stage-B dependency on `expr-rebuild` (§5 constraint 5) is not wired through the declared `after`/`before` mechanism the registry actually validates

**Sections:** 07 §2.3, §5 constraint 5.

§5 constraint 5 says "`expr-rebuild` is first in stage B and everything else in
stage B depends on it," stated as a global rule in prose. But §2.3's registry
validation only checks *declared* `after`/`before` fields per pass (§2:
"Optional: passes that must have run first... Enforced by the registry"). Unless
every stage-B pass explicitly declares `after: ["expr-rebuild"]`, PL-07's
load-time cycle/ordering check has nothing to validate against for this
specific, load-bearing dependency, and a future stage-B pass registered without
that declaration would silently run in whatever position the `REGISTRY` array
puts it, undetected until it fires on unrebuilt `let r0…rN` code. Make the rule
mechanical: either the registry auto-injects `after: ["expr-rebuild"]` for
every stage-B pass except `expr-rebuild` itself, or §7's per-pass workflow
checklist adds "declare `after: ["expr-rebuild"]`" as a mandatory step for
every stage-B pass.

### N3 — Spec 06's harness promotion table (§1) matches `tools/equiv/`'s real layout closely but doesn't mention the `hbc2js-equiv` wrapper script or that only one test file exists today

**Section:** 06 §1.

Checked directly: `tools/equiv/src/*.mjs` matches every row of §1's table
one-to-one (`trace.mjs`, `sandbox.mjs`, `child.mjs`, `compare.mjs`, `fuzz.mjs`,
`hermes.mjs`, `normalise-disasm.mjs`, `mutate.mjs`, `runner.mjs`, `cli.mjs`,
`selftest.mjs` all present), and `tools/equiv/examples/rt-*.js` matches §5's
`docs/EQUIVALENCE.md` §4.3 references — this is a clean, accurate promotion
plan, no defect found. The only thing missing from §1's table is the
`tools/equiv/hbc2js-equiv` executable wrapper (a thin shell/shebang entry point
distinct from `src/cli.mjs`) and the fact that all 19 unit tests currently live
in one file (`test/equiv.test.mjs`), not the one-module-per-concern split
`src/harness/**`'s file list might suggest. Neither blocks anything; worth a
line so the M3 implementer doesn't go looking for tests that were split up.

---

## What holds up

Positive findings worth recording so they aren't re-litigated: the switch
jump-table model (03 §4.2, T2), the exception-region carving algorithm and its
"disjoint ranges sharing one target" case (03 §5, verified against
`hermes-dec-sample` v99's real 5- and 7-handler tables), the `finally`
duplication model (03 §3.3, PRIOR-ART §6.3 — verified byte-for-byte on
`13-try-finally-no-catch`: the `log.push('cleanup')` body is genuinely
duplicated into both the normal exit and the catch-and-rethrow handler), the
method-call fast-path pattern (05 §7.4, verified: `GetByIdShort` into a
register that is then reused as `thisArg` in the same `Call`), the flattened
obfuscated-switch reducibility claim (03 §8 — reproduced with a synthetic
loop+switch dispatcher: zero irreducibility markers, one loop header, exactly
as claimed), and spec 06's harness promotion plan against the real
`tools/equiv/` tree (no defect found, see N3). No cycle exists in spec 07's
declared pass-ordering constraints (yield-recovery → other stage A →
finally-dedup → loop-recovery → switch-raise, then expr-rebuild → rest of
stage B) — the only issue found there is N2's mechanism gap, not a cycle.
