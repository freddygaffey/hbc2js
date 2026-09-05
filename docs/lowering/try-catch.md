# `try-catch` — `try { } catch (e) { }` / `catch { }`

**Fixtures:** `12-try-catch-finally-return`, `14-nested-try-catch`,
`15-catch-without-binding`
**Confidence:** ✅ verified (v94, v99 `-O0`, identical shape)

## 1. Source

```js
function f2() {
  try {
    throw new Error('boom');
  } catch (e) {
    return 'from-catch:' + e.message;
  } finally {
    return 'finally-wins';
  }
}
```
(`finally`'s interaction is covered separately in `try-finally-dedup.md`;
this file is the plain catch mechanism.)

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`,
`f2`:

```
[@ 18] TryGetById 6<Reg8>, 4<Reg8>, 1<UInt8>, 8<UInt16>   ; Error
[@ 24] GetByIdShort 7<Reg8>, 6<Reg8>, 2<UInt8>, 14<UInt8>
[@ 29] CreateThis 8<Reg8>, 7<Reg8>, 6<Reg8>
...
[@ 47] Throw 10<Reg8>                                      ; throw new Error('boom')  -- END of protected range
[@ 49] Catch 6<Reg8>                                       ; catch(e) { ... } -- HANDLER ENTRY, binds e into r6
[@ 51] StoreToEnvironment 0<Reg8>, 0<UInt8>, 6<Reg8>       ; e captured into env slot 0 (closed over / referenced later)
[@ 55] LoadFromEnvironment 7<Reg8>, 0<Reg8>, 0<UInt8>
[@ 59] GetByIdShort 8<Reg8>, 7<Reg8>, 3<UInt8>, 12<UInt8>  ; e.message
...
[@ 68] Ret 1<Reg8>                                          ; (this Ret is finally-overridden — see try-finally-dedup.md)

Exception Handlers:
0: start = 18, end = 49, target = 49
```

Optional catch binding (`catch {}`, `15-catch-without-binding`) simply omits
the environment store — the handler block still begins with `Catch r`
(the VM always binds the thrown value to a register; ECMAScript's optional
binding is a **source-level** elision only), but nothing subsequently reads
or stores that register:

```
[@ N] Catch 4<Reg8>
[@ N+2] <handler body, never referencing r4>
```

## 3. CFG/IR shape

Per `docs/HBC-FORMAT.md` §4.3 and spec 03 §3.3: a handler-table entry
`{start, end, target}` where `[start, end)` is the protected range
(function-relative, `end` exclusive) and `target` is the handler block's
offset — that block's **first instruction is always `Catch <reg>`**, which
is how a decompiler identifies a handler entry block at all (spec 03's
`BasicBlock.isHandlerEntry`/`catchRegister`). The protected range corresponds
exactly to the lexical `try` body's bytecode span; the handler block
corresponds to the `catch` body. Exception edges are **not** part of the
normal CFG (D7) — `Catch`'s block is reached only via the side
`exceptionSuccs` map, never via a `succs` edge from inside the try range.

## 4. Matcher

Recognises: an `ExceptionRegion` (spec 03 §3.3) whose `handlerBlock` begins
with `Catch dst`. Distinguishes plain `try`/`catch` from the `finally`
idiom (`try-finally-dedup.md`) by checking `sharesHandlerWith` — a plain
`try`/`catch` handler is **not** shared by another region that also covers
code following the `catch` body (finally's synthesized catch-and-rethrow
covers the try **and** the catch together; see that file). Also refuses to
match a handler whose body is the compiler's own `for-of`/destructuring
`IteratorClose`-then-`Throw` cleanup shape (`for-of.md` §4) — that pass must
claim those regions first.

## 5. Writer

Emits `try { B } catch (e) { H }` if `dst` (the `Catch` register) is read
anywhere in `H`, else `try { B } catch { H }` (optional binding, ES2019).

## 6. Checker

Beyond stage-A default: asserts the protected range `[start, end)` maps
exactly onto the recovered `try` body's block set (no block inside the range
is left dangling outside the emitted `try`, and no block outside the range
is pulled in).

## 7. Version differences

None in the handler-table mechanism or the `Catch`-leader convention — this
is unchanged from v94 through v99 (confirmed by cross-reading `12`'s v99
`-O0` dump, which reproduces the identical `Catch`/handler-table shape
modulo the v≥97 explicit-environment opcodes noted in `closures-env-slots.md`).

## 8. Emitter scaffolding (`__pc` / `__exc`) — measured for spec 22

Not bytecode: this is what *our* emitter prints around a recovered `try`
(`src/emit/function.ts` `planTries`, `src/emit/names.ts`). Recorded here
because `docs/specs/passes/22-try-shape-try-clean.md` (rungs `try-shape` and
`try-clean`) is the consumer of these shapes.

Measured 2026-09-05 by decompiling fixtures 12-16 at **v94 and v99** with the
default pipeline:

* `let __exc;` per function with any exception region; `let __pc = -1;` per
  function where any region needs a guard.
* `__pc = <blockId>;` at the head of every non-synthetic block of such a
  function — function-wide, including blocks outside every `try`, and (v99,
  fixture 16) as a comma element inside a `for` header's update slot.
* `if (!(__pc >= lo && __pc <= hi)) { throw _excN; }` first in a handler whose
  lexical `try` over-reaches the region's blocks; `[lo, hi]` is the region's
  block-id range. Observed: `[0,0]` (15 v94), `[1,1]` (13), `[0,1]` (12),
  `[1,2]` (14 v94), `[2,3]` and `[14,15]` (16 v99).
* `__exc = _excN;` next in the handler (the `Catch r` lowering reads it as
  `r = __exc`). Reads can also appear *outside* the handler on the path where
  it already ran (16 v99: `r12 = __exc;` after the `try`).

Fixture 16 at v94 is the irreducible shape: a `__state0` dispatch nest whose
tries carry `cfgBlock: -1`, where the guard *selects* the handler and is
therefore never removable.

**Versions unread for this scaffolding: 84, 96, 98.** The scaffolding is
emitter-side and version-independent by construction (it keys on
`ExceptionRegion`, which every version has), but that is an argument, not a
reading — spec 22 §7 open question 3 asks the implementer to confirm it while
running the fixture tests and to update this section.
