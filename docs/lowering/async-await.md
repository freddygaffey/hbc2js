# `async`/`await` — generator + builtin spawn helper

**Fixtures:** `27-async-await-basic`, `28-async-await-error`,
`29-promise-chaining`
**Confidence:** ✅ single-version (v94 shape); ⛔ inferred (v99 driver
protocol — the builtin that runs the lowered body to completion was not
traced instruction-by-instruction)

## 1. Source

```js
function resolveAfter(value) { return Promise.resolve(value); }
async function sequence() {
  print('start');
  const a = await resolveAfter(1);
  print('got a=' + a);
  ...
  return a + b + c;
}
```

## 2. Bytecode — v94 (opcode-driven era)

`tools/hermesc/v94/hermesc -dump-bytecode -pretty-disassemble=false`:

```
Function<global>:
  [@ 25] CreateAsyncClosure 2<Reg8>, 1<Reg8>, 2<UInt16>   ; sequence — confirms PRIOR-ART §6.2's prediction exactly
  [@ 30] PutById 0<Reg8>, 2<Reg8>, 2<UInt8>, ...

NCFunction<sequence>(1 params, 15 registers, ...):         ; the visible async-function stub
NCFunction<?anon_0_sequence>(1 params, 1 registers, ...):  ; a second, tinier wrapper layer
Function<?anon_0_?anon_0_sequence>(1 params, 15 registers, ...):  ; the REAL body — opcode-driven generator:
  [@ 0] StartGenerator
  [@ 1] ResumeGenerator 0<Reg8>, 1<Reg8>
  [@ 4] JmpTrueLong 179<Addr32>, 1<Reg8>
  [@ 10] ... print('start') ...
  [@ 29] ... resolveAfter(1) ...
  [@ 42] SaveGenerator 4<Addr8>        ; `await resolveAfter(1)` = SUSPEND, yielding the promise
  [@ 44] Ret 1<Reg8>
  [@ 46] ResumeGenerator 1<Reg8>, 2<Reg8>   ; resumed with the settled value -> `a`
  ...
```

**`await` desugars into exactly the same suspend/resume shape as `yield`**
(idiom `generators.md` era 1), inside a **hidden, doubly-wrapped generator**
that the visible `async function` is never itself. `CreateAsyncClosure`
(builtin numbering is version-dependent per `docs/HBC-FORMAT.md` §11.4 —
confirmed distinct index at v94 vs v99, matching `spawnAsync`'s own #52-at-
v94/#57-at-v99 shift already documented in `docs/TOOLCHAIN.md`) marks the
creation site; something in the doubly-wrapped stub chain (not traced to the
opcode level in this pass) is expected to call a `spawnAsync`-family builtin
(via `GetBuiltinClosure`, per PRIOR-ART §6.2) that drives the hidden
generator to completion, turning each yielded promise into the next
resume's sent value once it settles, and wrapping the whole thing in a real
`Promise` for the caller.

## 3. Bytecode — v99 (lowered era)

```
Function<global> function list:
  NCFunction<sequence>(1 params, 2 registers, ...)          ; tiny wrapper, same shape as generators.md's NCFunction
  Function<>(2 params, 13 registers, ...)                    ; UNNAMED — likely the spawn-driver's continuation
  NCFunction<?anon_0_sequence>(1 params, 2 registers, ...)   ; a second tiny wrapper
  Function<?anon_0_sequence>(1 params, 21 registers, ...)    ; the REAL body, using the v99 LOWERED state-machine
                                                                convention (generators.md §3/§4) — same
                                                                CreateGenerator + two-reserved-slot + compare-chain
                                                                dispatch shape, not a distinct "async" bytecode idiom.
```

**Async at v99 is not a separate lowering from generators at v99** — it is
the *identical* `CreateGenerator` + lowered-state-machine body convention,
wrapped in one additional unnamed driver function whose job (inferred, not
traced) is to run the hidden generator via the same resume ABI
`generators.md` §4 marks ⛔, feeding it `Promise`-settlement values instead
of `.next()` call arguments, and returning a real `Promise` to the caller of
`sequence()`.

## 4. CFG/IR shape

For the D9 shim's purposes, `async function` requires **no additional
machinery beyond what `generators.md` already describes**: recognise the
`CreateAsyncClosure` (v≤96) or the async `FunctionHeader.flags.kind` (v≥97,
spec 01 §3.4) exactly as `classifyFunctions` (spec 03 §2) already plans to,
set `kind: "async"`, and apply the identical `shimRequired`/
`innerFunctionIndex` treatment as `kind: "generator"`. The emitted shim
(`__hbc_makeGenerator`-equivalent, or a sibling `__hbc_makeAsync` if the
driver behaviour differs enough to need one) still only needs the body
function to behave correctly under the *same* opaque resume protocol;
nothing here changes spec 03's "nothing special-cases the CFG" conclusion.

## 5. Matcher / Writer / Checker

Deferred to `generators.md` — this idiom is a thin variant, not an
independent shape. A `src/passes/` implementer should treat
`kind === "async"` as sharing the generator matcher/writer/checker modulo
the wrapping constructor call (`CreateAsyncClosure` vs `CreateGeneratorClosure`
at v≤96; identical `CreateGenerator` at v≥97, distinguished only by
`FunctionHeader.flags.kind`).

## 6. Version differences

Same table as `generators.md` §6 applies. Additionally: the builtin(s)
driving the hidden coroutine to completion (`spawnAsync` at v94's builtin
#52, a differently-numbered builtin at v99 per `docs/TOOLCHAIN.md`'s
byte-identical-recompilation research, which found the public v99
`hermesc` resolves `#58 makeAsyncIterator` at a call site where the
preserved historical fixture resolves `#57 spawnAsync` — a genuinely
different Hermes commit's builtin table, not a flag difference) were not
traced to their calling convention in this pass. **Flagged for the next T3
session or the `async-await` pass implementer**: confirm which builtin
actually drives `sequence`'s hidden generator at each version before
writing `src/passes/async-await/`.
