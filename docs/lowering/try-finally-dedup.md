# `finally-dedup` — `try { } finally { }` (duplicated-body idiom)

**Fixtures:** `12-try-catch-finally-return`, `13-try-finally-no-catch`,
`16-finally-with-break-continue`
**Confidence:** ✅ verified (v94, v99 `-O0`, identical shape)

**`finally` has no bytecode representation of its own.** Per
`docs/HBC-FORMAT.md` §4.3 and `docs/specs/03-cfg.md` §3.3: the compiler
duplicates the `finally` body's statements into (a) the normal fall-through
path after the `try` (and after each `catch`, if present) and (b) a
synthesized catch-and-rethrow handler that additionally protects the `try`
body **and** any user `catch` clause. This file is the full mechanical
account, including the `break`/`continue`-suppresses-the-exception case
that is the most surprising part of it.

## 1. Source, case A — `finally` overrides a `try` return, no `catch`

```js
function f3() {
  try {
    return 'try-value';
  } finally {
    print('finally ran, but does not return here');
  }
}
```

## 2a. Bytecode — case A

`tools/hermesc/v94/hermesc -O0`:

```
[@ 14] TryGetById 4<Reg8>, 0<Reg8>, 1<UInt8>, 13<UInt16>   ; print
[@ 26] Call 5<Reg8>, 4<Reg8>, 2<UInt8>                     ; print('finally ran...')  -- COPY 1 (normal path)
[@ 30] Ret 3<Reg8>                                          ; return 'try-value'
[@ 32] Catch 4<Reg8>                                        ; handler entry
[@ 34] TryGetById 5<Reg8>, 0<Reg8>, 1<UInt8>, 13<UInt16>
[@ 46] Call 6<Reg8>, 5<Reg8>, 2<UInt8>                     ; print('finally ran...')  -- COPY 2 (exceptional path)
[@ 50] Throw 4<Reg8>                                        ; re-throw the original exception (finally has no override here)
```
Two literal calls to `print`, one per copy — the clearest possible evidence
of duplication. Handler table: one entry, `{start: try-body, end: <end of
try+its own instructions>, target: <the Catch above>}`.

## 1b. Source, case B — `finally` **overrides** both a `try` and a `catch` return

```js
function f2() {
  try { throw new Error('boom'); }
  catch (e) { return 'from-catch:' + e.message; }
  finally { return 'finally-wins'; }
}
```

## 2b. Bytecode — case B

```
[@ 2] LoadConstString 1<Reg8>, 'finally-wins'   ; computed FIRST, unconditionally, before anything else
...
[@ 47] Throw 10<Reg8>                            ; try body: throw new Error('boom')
[@ 49] Catch 6<Reg8>                             ; user's catch(e)
[@ 51] StoreToEnvironment 0<Reg8>, 0<UInt8>, 6<Reg8>
[@ 55] LoadFromEnvironment 7<Reg8>, 0<Reg8>, 0<UInt8>
[@ 59] GetByIdShort 8<Reg8>, 7<Reg8>, 3<UInt8>, 12<UInt8>  ; e.message  (computed, but its result is UNUSED)
[@ 64] Add 9<Reg8>, 3<Reg8>, 8<Reg8>                       ; 'from-catch:'+e.message (computed, UNUSED)
[@ 68] Ret 1<Reg8>                                          ; returns r1 = 'finally-wins', NOT the catch's own value
[@ 70] Catch 6<Reg8>                                        ; SECOND handler — protects the catch clause too
[@ 72] Ret 1<Reg8>                                          ; ALSO returns 'finally-wins' (does not rethrow!)

Exception Handlers:
0: start = 18, end = 49, target = 49    ; protects the TRY body, handler = the user's catch
1: start = 18, end = 68, target = 70    ; protects TRY + CATCH together, handler = finally's own catch-and-rethrow
```

Two nested/overlapping handler-table entries (per `docs/HBC-FORMAT.md` §4.3
— "may overlap and nest"): the outer range `[18, 68)` covers **both** the
`try` body and the user's `catch` body, because `finally` must run even if
the `catch` clause itself throws. Its handler (`target = 70`) is the
catch-and-rethrow twin. Because `finally` here unconditionally `return`s, the
"rethrow" twin does not actually rethrow — it returns the finally's value
just like the normal-path copy, discarding whatever was in flight (return
value from `catch`, or a fresh exception thrown from `catch`). **A `return`
in `finally` always wins, over a `try`-return, a `catch`-return, and even an
exception raised while evaluating the `catch` clause.**

## 1c. Source, case C — `continue` inside `finally` suppresses a pending exception

```js
for (let i = 0; i < 5; i++) {
  try {
    if (i === 2) throw new Error('at ' + i);
    trace.push('ok:' + i);
  } finally {
    if (i === 2) { trace.push('finally-continue-suppresses-throw:' + i); continue; }
  }
  trace.push('after-try:' + i);
}
```

## 2c. Bytecode — case C

```
[@ 246] Throw 23<Reg8>              ; throw new Error('at '+i)   -- inside the protected try body
[@ 248] Catch 17<Reg8>              ; handler: r17 = the caught exception object
[@ 250] LoadFromEnvironment 18<Reg8>, 0<Reg8>, 1<UInt8>   ; i
[@ 254] StrictEq 19<Reg8>, 18<Reg8>, 6<Reg8>              ; i === 2   (the finally body's own `if`)
[@ 258] JmpTrue 5<Addr8>, 19<Reg8>                        ; true -> SKIP the rethrow, fall into the `continue` path
[@ 261] Throw 17<Reg8>                                     ; false -> rethrow (finally falls through normally)
[@ 263] ... trace.push('finally-continue-suppresses-throw:'+i) ...
[@ 293] LoadFromEnvironment 18<Reg8>, 0<Reg8>, 1<UInt8>   ; i
[@ 297] ToNumeric/Inc/StoreToEnvironment                  ; i++  -- the FOR LOOP'S OWN UPDATE
[@ 307] Less/JmpTrueLong ...                              ; -> back to loop header  (this IS `continue`'s target)
```

**This is the mechanism, precisely.** `continue` inside `finally` is not a
special opcode or a flag that "cancels" the in-flight exception — the
synthesized catch-and-rethrow handler's `Throw r17` is simply **one
reachable path among several**, guarded by the same `if` the source wrote.
When the `if`'s condition steers control down the `continue` arm, execution
falls straight into the loop's ordinary update/back-edge block — the exact
same block an ordinary (non-exceptional) `continue` from inside the `try`
would target — and the `Throw` is never reached. The pending exception
object (`r17`) is simply never used again; it becomes garbage. `break`
inside `finally` works identically, landing on the loop's join block instead
of its update block (see `while-loop.md` for what those blocks are).

## 3. CFG/IR shape

`sharesHandlerWith` (spec 03 §3.3) is exactly how a decompiler recognises
this idiom without pattern-matching on the handler body's instructions:
multiple `ExceptionRegion` table entries whose `target` is the **same**
block indicate either (a) one `catch` protecting several disjoint `try`
sub-ranges (not this idiom), or (b) `finally`'s synthesized handler
protecting both a `try` and its own `catch` clause, distinguished by (b)'s
regions being *nested* (one region's range strictly contains the other's
start but the handler is identical) rather than disjoint. The normal-path
copy of the `finally` body is found by: the block(s) immediately following
the `try` (and `catch`, if present) body's normal exit, up to but not
including the point where control would otherwise leave the enclosing
`try`/`catch`/`finally` statement (return, fall through to next statement,
or loop back-edge/exit) — and this instruction sequence must be
**isomorphic** (spec 04's `checkIsomorphic`, reused per `docs/specs/07-pass-ladder.md`
§2.2) to the corresponding prefix of the catch-and-rethrow handler block.

## 4. Matcher

Recognises: two (or more) `ExceptionRegion`s sharing a `target` block `H`,
where `H`'s instruction sequence — up to its first control-transfer
instruction that is NOT common to some other copy of the same instructions
found on a normal-path block right after the protected range — is
isomorphic to that normal-path block. Captures the **shared prefix** as the
`finally` body and the **divergent suffix** of `H` (typically just `Throw
<caughtReg>`, but may be guarded by the finally body's own `if`s, per case
C) as evidence that this suffix is NOT part of the `finally` body — it's the
compiler's rethrow, and must be dropped, not emitted. Refuses to match:
- a shared-target pair where the prefixes are **not** isomorphic (that is
  two genuinely different handlers coincidentally targeting the same
  address, which should not happen from `hermesc` but a matcher must not
  assume the input is always "nice" — see obfuscated variants);
- a single (non-duplicated) handler with no corresponding normal-path copy
  (that's plain `try`/`catch`, `try-catch.md`'s matcher's job, run first).

## 5. Writer

Emits `try { B } finally { F }` (or `try { B } catch (e) { C } finally { F
}` when a user catch is also present), with `F` taken from **either** copy
(they are isomorphic by construction) and the synthesized rethrow/suppress
logic entirely dropped — it is implied by `finally`'s semantics in JS and
does not need to be represented. `break`/`continue`/`return` appearing
inside the recovered `F` come from whichever arm of `H` didn't reach
`Throw` — i.e. `F`'s recovery must in general use the **handler-side**
copy's control-transfer instructions (`continue`/`break`/`return`), not the
normal-path copy's (which for a `finally` with no override just falls
through), because only the handler side shows what happens to a pending
exception.

## 6. Checker

Beyond stage-A default: asserts (a) the normal-path copy and the
handler-side copy's shared prefix really are instruction-isomorphic (not
just "close enough"), and (b) every exit from the shared prefix in the
handler-side copy either reaches the rethrow (`Throw <caughtReg>`, in which
case that arm is dropped from `F`) or reaches some other control transfer
identical in kind and target to what the corresponding normal-path exit
would reach (in which case `F` is emitted with that same transfer, and the
"this suppresses a pending exception" semantics is exactly captured by JS's
own `finally` rules — no special IR node is needed for the suppression, it
falls out of emitting `F` faithfully with its actual control transfers).

## 7. Version differences

None in the duplication mechanism, handler-table nesting, or
`sharesHandlerWith` shape — confirmed identical at v94 and v99 (`-O0`, cases
A and the `f3` case were cross-read at both versions). The only difference
between versions is the unrelated environment-opcode family
(`GetParentEnvironment`/`CreateFunctionEnvironment` at v≥97 vs
`CreateEnvironment` at v≤96) used for whatever locals happen to be captured
by the `try`/`catch`/`finally` — see `closures-env-slots.md`.

## 8. A note on dead exception regions

`f1` (`try { return 'from-try' } finally { return 'from-finally' }`, no
`catch`) shows the optimizer can determine the `try` body **cannot throw**
(`LoadConstString`/`Ret` alone) and, at default `-O`, **removes the handler
table entry for it entirely** — while leaving the catch-and-rethrow block's
instructions in the bytecode as dead code (never targeted by any handler
entry, unreachable). A decompiler that walks the instruction stream
looking for `Catch` rather than starting from the handler table would
mis-detect this dead block as a live handler. **Always derive exception
regions from the handler table (spec 03 §3.3), never from scanning for
`Catch` opcodes.**
