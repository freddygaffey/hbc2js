# Generators — two eras, and the v≥97 calling convention (D9 shim boundary)

**Fixtures:** `23-generator-basic`, `24-generator-return-throw`,
`25-generator-delegation`, `26-infinite-generator-take`
**Confidence:** ✅ verified (v≤96 opcode-driven shape, v94); ✅ verified (v≥97
overall architecture: `CreateGenerator` + wrapper/body split, v99); ✅
**measured** (the integer encoding of the v≥97 resume-call ABI — the
action and status codes, read at v98 *and* v99, see §4; T13). Per D9, the
shim needs only the architecture; the ABI codes are what `yield`-recovery
*inside* the lowered body needs, and they are now pinned rather than
inferred.

## 1. Source

```js
function* sequence() {
  yield 'a';
  yield 'b';
  const x = yield 'c';
  yield 'received:' + x;
  return 'final';
}
```

## 2. Bytecode — era 1, v≤96 (`StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`)

`tools/hermesc/v94/hermesc -dump-bytecode -pretty-disassemble=false`. The
function bound to the name `sequence` is a **separate, tiny outer stub**
(`CreateGeneratorClosure` at the creation site, in `global`); the body below
is compiled into its own function table entry, named `?anon_0_sequence` by
the disassembler:

```
Function<?anon_0_sequence>(1 params, 6 registers, 0 symbols):
[@ 0] StartGenerator
[@ 1] ResumeGenerator 0<Reg8>, 1<Reg8>       ; r0 = sent value; r1 = isReturn flag
[@ 4] JmpTrue 82<Addr8>, 1<Reg8>             ; isReturn -> jump to the LAST suspend point's forced-return block
[@ 7] LoadConstString 1<Reg8>, 'a'
[@ 11] SaveGenerator 4<Addr8>                ; suspend; resume lands at the NEXT ResumeGenerator (offset 15)
[@ 13] Ret 1<Reg8>                           ; canonical `r = yield v` shape: SaveGenerator immediately followed by Ret
[@ 15] ResumeGenerator 1<Reg8>, 2<Reg8>
[@ 18] JmpTrue 65<Addr8>, 2<Reg8>
[@ 21] LoadConstString 2<Reg8>, 'b'
[@ 25] SaveGenerator 4<Addr8>
[@ 27] Ret 2<Reg8>
[@ 29] ResumeGenerator 2<Reg8>, 3<Reg8>       ; this resume's sent value becomes `x`
[@ 32] JmpTrue 48<Addr8>, 3<Reg8>
[@ 35] LoadConstString 3<Reg8>, 'c'
[@ 39] SaveGenerator 4<Addr8>
[@ 41] Ret 3<Reg8>
[@ 43] ResumeGenerator 3<Reg8>, 4<Reg8>
[@ 46] JmpTrue 31<Addr8>, 4<Reg8>
[@ 49] LoadConstString 4<Reg8>, 'received:'
[@ 53] Add 4<Reg8>, 4<Reg8>, 3<Reg8>          ; 'received:' + x
[@ 57] SaveGenerator 4<Addr8>
[@ 59] Ret 4<Reg8>
[@ 61] ResumeGenerator 4<Reg8>, 5<Reg8>
[@ 64] JmpTrue 10<Addr8>, 5<Reg8>
[@ 67] LoadConstString 5<Reg8>, 'final'
[@ 71] CompleteGenerator
[@ 72] Ret 5<Reg8>                            ; natural return
[@ 74] CompleteGenerator
[@ 75] Ret 4<Reg8>                            ; forced .return() at suspend point 3 (returns the value it was called with)
[@ 77] CompleteGenerator
[@ 78] Ret 3<Reg8>                            ; forced .return() at suspend point 2
[@ 80] CompleteGenerator
[@ 81] Ret 2<Reg8>                            ; forced .return() at suspend point 1
[@ 83] CompleteGenerator
[@ 84] Ret 1<Reg8>                            ; forced .return() at suspend point 0
[@ 86] CompleteGenerator
[@ 87] Ret 0<Reg8>                            ; forced .return() before ever starting
```

Exactly PRIOR-ART §6.2's predicted shape, now directly confirmed. Two
details worth recording precisely:
- **The `isReturn` check comes before the yield-point's own logic runs**,
  and its jump target is a **dedicated tail block specific to that suspend
  point** (`CompleteGenerator; Ret <lastComputedValue>`) — there is one such
  tail block per `ResumeGenerator`, chained in reverse suspend-point order
  at the end of the function. A `.return(v)` call resumes the SAME
  `ResumeGenerator` instruction the corresponding `.next()` would have, but
  with `isReturn=true`, redirecting to that suspend point's own completion
  tail rather than continuing the body.
- **`const x = yield 'c'`** is exactly `SaveGenerator; Ret <the yielded
  value>` immediately followed, on resume, by `ResumeGenerator <dst>, ...`
  where `<dst>` becomes `x` — the "canonical" shape spec 03's
  `SuspendPoint.canonical` field is designed to detect.

## 3. Bytecode — era 2, v≥97 (`CreateGenerator` + lowered state machine)

At v99, the disassembler prints the SAME source function under **three**
distinct labels, and only one of them (the third) is what most research
into "generator lowering" usually means:

```
Function<global>:
  [@ 15] CreateClosure 2<Reg8>, 1<Reg8>, 1<UInt16>     ; sequence — an ORDINARY closure, not CreateGeneratorClosure!
  [@ 31] PutByIdLoose 0<Reg8>, 2<Reg8>, 1<UInt8>, ...   ; binds it to the name `sequence`

NCFunction<sequence>(1 params, 2 registers, ...):        ; <-- THIS is function-table index 1, what CreateClosure pointed to.
  [@ 0] CreateFunctionEnvironment 1<Reg8>, 3<UInt8>       ; fresh 3-slot env for THIS generator instance
  [@ 3] LoadConstZero 0<Reg8>
  [@ 5] StoreNPToEnvironment 1<Reg8>, 1<UInt8>, 0<Reg8>   ; env slot 1 = 0   ("resume/yield-point index", init 0)
  [@ 9] StoreNPToEnvironment 1<Reg8>, 2<UInt8>, 0<Reg8>   ; env slot 2 = 0   ("status", init 0)
  [@ 13] CreateGenerator 1<Reg8>, 1<Reg8>, 3<UInt16>      ; allocate the real Generator object, body = function #3
  [@ 18] Ret 1<Reg8>                                       ; return it — THIS is what `sequence()` actually returns

Function<sequence>(1 params, 18 registers, ...):          ; function-table index 3 — CreateGenerator's operand.
                                                             ; THIS is the per-resume "body"/state-machine function,
                                                             ; called by VM-internal machinery, never by ordinary JS `Call`.
  [@ 0] GetParentEnvironment 1<Reg8>, 0<UInt8>              ; r1 = the env NCFunction<sequence> created
  [@ 3] LoadFromEnvironment 0<Reg8>, 1<Reg8>, 2<UInt8>      ; r0 = status
  [@ 10] LoadConstUInt8 4<Reg8>, 2<UInt8>
  [@ 13] JStrictEqualLong 428<Addr32>, 0<Reg8>, 4<Reg8>     ; status===2 -> "already executing/done" trap
  [@ 20] LoadParam 0<Reg8>, 2<UInt8>                        ; <-- resume payload param #2 ("ACTION", inferred)
  [@ 23] LoadParam 3<Reg8>, 1<UInt8>                        ; <-- resume payload param #1 ("VALUE", inferred)
  [@ 42] StoreNPToEnvironment 1<Reg8>, 2<UInt8>, r4(=2)     ; status := 2 IMMEDIATELY (reentrancy guard)
  [@ 46] LoadFromEnvironment r7, 1<Reg8>, 1<UInt8>          ; r7 = resume/yield-point index
  [@ 52] JStrictEqualLong ..., 0, r7                        ; dispatch: yield-point 0
  [@ 59] JStrictEqualLong ..., 1, r7                        ; dispatch: yield-point 1
  [@ 69] JStrictEqualLong ..., 2, r7                        ; dispatch: yield-point 2 (the `const x = yield 'c'` site)
  [@ 76] JStrictEqual ..., 3, r7                            ; dispatch: yield-point 3
  ... each arm: compute the yielded value, StoreNPToEnvironment (status, resume-index for NEXT call),
      NewObjectWithBuffer {value, done:false} (or PutOwnBySlotIdx to patch `done:true` on the final arm), Ret
  [@ 455] CallBuiltin 0<Reg8>, 44<UInt8>, 2<UInt8>          ; constructs/throws "Generator functions may not be
                                                              called on executing generators" (string confirmed
                                                              present in the string table per HBC-FORMAT §5.3)
```

## 4. The v≥97 calling convention, stated as precisely as this research pins it

**High confidence (directly read from bytecode, this is the D9 shim
boundary itself):**
- `CreateGenerator dst, env, bodyFunctionIndex` is the **single** opcode
  that marks a generator at v≥97. `bodyFunctionIndex` is exactly what
  `docs/specs/03-cfg.md` §3.4's `innerFunctionIndex` needs — no scanning of
  the body for `StartGenerator` is required or possible at this era (that
  opcode no longer exists).
- The function the source name (`sequence`) is bound to (via `CreateClosure`
  at the module/enclosing-function level, printed as `NCFunction<sequence>`
  by the disassembler) is a **trivial wrapper**: it allocates a fresh
  environment sized for (2 reserved control slots + N of the function's own
  locals/params that must survive across yields), zero-initializes the 2
  control slots, calls `CreateGenerator`, and returns the resulting Generator
  object. **This wrapper is exactly what the D9 shim replaces** with
  `__hbc_makeGenerator(bodyFn, env)` — spec 03 §3.4's "for `era: 'lowered'`,
  the CFG is ordinary... set `shimRequired: true`" is confirmed sufficient:
  nothing about this wrapper needs CFG-level recognition beyond "it calls
  `CreateGenerator`."
- The body function (`Function<sequence>`, a **separate** table entry) is
  invoked by VM-internal generator-resume machinery, not by an ordinary `Call`
  from JS-visible code — its `LoadParam` reads at indices beyond the
  source-declared parameter count are the resume payload.
- Internally, the body keeps exactly two dedicated environment slots: a
  **status** slot (confirmed value `2` means "currently executing, or
  already done" — checked first, unconditionally, and is the trap that
  produces the "may not be called on executing generators" `TypeError`) and
  a **resume/yield-point index** slot used in a plain `JStrictEqual`/
  `JStrictEqualLong` compare chain (idiom `switch.md` #6) to dispatch to the
  correct resume site — **this dispatch is not a distinct "generator
  opcode" idiom, it is the ordinary compare-chain switch idiom**, which
  means `switch-raise` could in principle also fire here; a matcher for
  this idiom must claim the site first (ordering constraint) or explicitly
  recognise "this compare chain is gated behind the two reserved env
  slots" and exclude it from `switch-raise`'s targets.
- Each yield/return site builds its `{value, done}` result via
  `NewObjectWithBuffer` (pre-baked shape+value for the common case) plus, for
  `done: true`, a `PutOwnBySlotIdx` patching the `done` field on top of a
  shape shared with `done: false` — same pattern spec 03/PRIOR-ART predicted.
- `try`/`finally` **inside** a generator body composes with this state
  machine exactly as it would in an ordinary function (`try-finally-dedup.md`
  applies unmodified) — confirmed via `24-generator-return-throw`'s `g1`,
  whose exception-handler table has 9 regions all sharing one target block,
  matching one shared-handler-per-dispatch-arm duplication.

**✅ Measured (T13, 2026-08-30) — the resume ABI, pinned:** every claim below
is read from `hbc2js disasm` on committed fixtures, at **both** v98 and v99,
whose prologues are instruction-for-instruction identical.

`24-generator-return-throw`, function #3 (`g1`'s body), v99 — verbatim:

```
  0000  GetParentEnvironment r1, 0
  0003  LoadFromEnvironment  r0, r1, 0      ; r0 = STATUS
  000a  LoadConstUInt8       r4, 2
  000d  JStrictEqualLong     L19, r0, r4    ; status === 2 -> "executing" trap
  0014  LoadParam            r0, 2          ; param 2 = VALUE
  0017  LoadParam            r3, 1          ; param 1 = ACTION
  001d  LoadConstUInt8       r7, 3
  0020  LoadConstUInt8       r5, 1
  0030  JStrictEqualLong     L16, r13, r7   ; entry status === 3 -> "completed"
L1:
  003a  StoreNPToEnvironment r1, 0, r4      ; status := 2 before running a step
  003e  LoadFromEnvironment  r13, r1, 1     ; r13 = resume-point index
  0042  JStrictEqualLong     L11, r12, r13  ; index === 0
  0049  JStrictEqualLong     L10, r5, r13   ; index === 1
  0050  JStrictEqualLong     L7,  r4, r13   ; index === 2
  0057  JStrictEqual         L4,  r7, r13   ; index === 3
  005b  JStrictEqual         L3,  r3, r5    ; ACTION === 1
  005f  JStrictEqual         L2,  r3, r4    ; ACTION === 2
```

- **Parameter roles.** `LoadParam 1` is the **action**; `LoadParam 2` is the
  **value** (sent value, thrown error, or return argument). The earlier
  reading of this file had them the other way round; the compare chain
  settles it — only `LoadParam 1`'s register is ever compared against small
  integer constants.
- **Action codes.** `1` = `.throw(e)` — arm `L3` sets the status to `3` and
  executes `Throw r0`, i.e. it throws the *value* parameter. `2` = `.return(v)`
  — arm `L2` sets the status to `3` and returns the result object. `0` =
  `.next(v)`, which is the fall-through: it is never compared for, because it
  is whatever is left once `1` and `2` are excluded.
- **Status codes**, in the slot read at entry: `0` not yet started (the
  wrapper's `LoadConstZero` + `StoreNPToEnvironment` initialiser), `1`
  suspended at a yield (stored before each `Ret` that hands back
  `{value, done:false}` — see `L4`, `L7`, `L11`), `2` currently executing
  (written immediately at `L1`, and the entry trap's value), `3` completed
  (written before every `Throw` and every `done:true` return).
- **Slot numbers are per-function, not fixed.** In
  `24-generator-return-throw` the status is env slot `0` and the resume index
  slot `1`; in `23-generator-basic`'s `counter` the status is slot `3` and the
  index slot `2`, because slot `0` there holds a captured parameter. Identify
  them **structurally**: the status slot is the one loaded first and compared
  against `2` before anything else runs; the index slot is the one loaded
  immediately after the status is set to `2`. Never hard-code the numbers.
- **What is still not pinned:** whether any action code above `2` exists
  (none is emitted by any fixture in this corpus), and whether the
  `.return()` arm's result object is built by the same `NewObjectWithBuffer`
  shape as an ordinary yield in every case. Neither blocks `yield` recovery.

**Why this split is safe for the M4 baseline (D9):** the shim only needs
the ✅ facts above — it treats the body function as an opaque, correct unit
run by real Hermes-equivalent semantics (or, for a pure-JS decompile target,
by a small runtime helper implementing the same resume protocol against a
*real* JS generator internally) and never needs to understand the resume ABI at all. Those details become
necessary only for the "v2" `yield`-recovery pass D9 describes — which spec 07
§4 blocked while this row was ⛔, and which T13's measurement above now
unblocks.

## 5. `yield*` delegation (`25-generator-delegation`)

Not traced instruction-by-instruction in this pass (time-boxed out); the
source (`yield* inner()`, `yield* [10,20,30]`, `yield* 'ab'`) is recorded
here as a fixture to trace next. At v≤96 this is expected to use a
`DelegateYield`-style pattern built from the ordinary iterator-protocol
opcodes (`for-of.md`) driving repeated `ResumeGenerator`/`SaveGenerator`
pairs; at v≥97 it is expected to be indistinguishable in shape from any
other iterator consumption inside the lowered body. **Confidence: ⛔ not
measured — do not assume either prediction without reading the actual
dump.**

## 5b. CFG hazard: v≤96 resume blocks have no static predecessor

Cross-referenced after `docs/specs/03-cfg.md` §4.5 was added (commit
`908cc1d`, blocker B1) — **consistent with, and derived from the same
fixture as**, §2 above, no disagreement. Worth restating here because it is
a correctness trap for anyone implementing against this file directly: in
`?anon_0_sequence`'s bytecode, each block starting at a `ResumeGenerator`
(offsets 15, 29, 43, 61 in §2's dump) has **zero static predecessors** — the
only way to reach them is the VM re-entering at a saved pc, which is opaque
runtime state, not a CFG edge. A dominator computation or reverse-postorder
walk that does not account for this will never visit those blocks, and
spec 04's structurer will silently omit the code that runs on the second and
subsequent `.next()` calls — not ugly output, *absent* output. Spec 03 §4.5
fixes this with a synthetic `B_dispatch` entry block: a fabricated
`switch`-terminated block (no real bytes, `start === end === -1`) prepended
as the function's entry, with `switch-case 0` to the real entry and
`switch-case k` to `suspendPoints[k-1].resumeBlock` for each saved state —
turning the opaque VM re-entry into an ordinary multi-way branch that
Ramsey structures into `switch (state) { case 0: ... case 1: ... }`, which
is, not coincidentally, exactly what the VM does at runtime. This applies
**only** to `era: "opcode"` bodies with `suspendPoints.length > 0` — the
v≥97 lowered era's dispatch chain (§3 above) is already reached by ordinary
branches from a single entry and needs no such fix (verified at v99 in this
file's own §3).

## 6. Version differences

| | v≤96 | v≥97 |
|---|---|---|
| Marks a generator | `CreateGeneratorClosure` at the creation site + body starts with `StartGenerator` | `FunctionHeader.flags.kind` (spec 01 §3.4) + `CreateGenerator` opcode naming the body function |
| Suspend/resume | Dedicated VM opcodes (`StartGenerator`/`ResumeGenerator`/`SaveGenerator`/`CompleteGenerator`) | Ordinary function calls + `LoadParam` beyond declared arity; no dedicated opcodes at all |
| Disassembler labels | `?anon_0_<name>` (body), plain-named stub (creation site's `CreateGeneratorClosure` target has no separate visible wrapper — the outer stub *is* the creation site) | `NCFunction<name>` (wrapper) + `Function<name>` (body) as **two separate table entries both carrying the source name** |
| `.next()`/`.throw()`/`.return()` dispatch | `ResumeGenerator`'s `isReturn` flag + per-suspend-point tail blocks | A `JStrictEqual`/`JStrictEqualLong` chain inside the body on inferred "action" and "status" values (⛔) |
