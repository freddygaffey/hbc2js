# `for-header` — `for (init; c; update) B`

**Fixture:** `tests/fixtures/constructs/04-for-loop-basic/source.js`
**Confidence:** ✅ verified (v94 and v99, both `-O0` — see §7 for the v99 dump)
**Pass:** `src/passes/for-header/` (stage A, after `loop-cond`)

## 1. Source

```js
let trace = [];
for (let i = 0, j = 10; i < j; i++, j--) {
  trace.push(i + ':' + j);
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:

```
[@ 89] StoreNPToEnvironment 0<Reg8>, 1<UInt8>, 2<Reg8>   ; i = 0   (init, hoisted before the loop)
[@ 93] StoreNPToEnvironment 0<Reg8>, 2<UInt8>, 3<Reg8>   ; j = 10  (init)
[@ 97] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 1<UInt8>   ; i
[@ 101] LoadFromEnvironment 18<Reg8>, 0<Reg8>, 2<UInt8>  ; j
[@ 105] Less 19<Reg8>, 17<Reg8>, 18<Reg8>                ; i < j
[@ 109] JmpFalse 84<Addr8>, 19<Reg8>                     ; pre-test, false -> exit
L:                                                        ; body: trace.push(i+':'+j)
... (Call at [@143]) ...
[@ 150] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 1<UInt8>  ; i
[@ 154] ToNumeric 18<Reg8>, 17<Reg8>
[@ 157] Inc 19<Reg8>, 18<Reg8>
[@ 161] StoreToEnvironment 0<Reg8>, 1<UInt8>, 19<Reg8>   ; i++   -- UPDATE, appended to body tail
[@ 165] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 2<UInt8>  ; j
[@ 169] ToNumeric 18<Reg8>, 17<Reg8>
[@ 172] Dec 19<Reg8>, 18<Reg8>
[@ 176] StoreToEnvironment 0<Reg8>, 2<UInt8>, 19<Reg8>   ; j--   -- second UPDATE (comma operator)
[@ 180] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 1<UInt8>
[@ 184] LoadFromEnvironment 18<Reg8>, 0<Reg8>, 2<UInt8>
[@ 188] Less 19<Reg8>, 17<Reg8>, 18<Reg8>                ; i < j  (RE-EVALUATED, back-edge test)
[@ 192] JmpTrue -95<Addr8>, 19<Reg8>                     ; -> back to L
```

## 3. CFG/IR shape

Exactly the `while-cond` rotation (idiom #2) with two additions that are
**not** distinguished by any bytecode marker: (a) the `init` instructions
appear immediately before the pre-test, with no intervening control flow —
they are simply the last instructions of the block that falls into the
header; (b) the `update` instructions (both of them, for the comma-operator
case) are appended to the **end of the body block**, immediately before the
back-edge's condition re-evaluation, again with no marker distinguishing
"this is the `for`'s update" from "this is just more body code." The comma
operator (`i++, j--`) produces two completely ordinary sequential
instruction groups — there is no comma/sequence opcode.

This means `for-header` cannot be identified from bytecode shape alone in
general — it requires the **liveness argument** spec 07 §6 row 6 calls out:
the "update" instructions are only recognizable as such because (i) they are
the last statements of the body, (ii) they write to the same
registers/environment slots the header's condition reads, and (iii) those
registers/slots are not otherwise live out of the loop in a way that would
make them "just more body statements that happen to come last." Absent that
liveness check, `for` is indistinguishable from `while` with the update
manually written as the last line of the body — which is in fact valid,
equivalent JS, so the matcher's job is a readability judgement, not a
correctness one.

## 4. Matcher

After `while-cond` has already turned the rotated shape into a structured
`while (c) { B }` (spec 07 §5 ordering constraint — `for-header` runs
**after** `while-cond`): recognises a `while (c) { B' ; U }` where `U` is a
suffix of `B'` such that (a) every register/slot `U` writes is read by `c`,
(b) `U`'s writes are not read anywhere in `B'` before `U` (i.e. `U` is
genuinely the loop increment, not code that happens to run before an
increment), and (c) the statement immediately preceding the `while` is an
assignment/declaration to the same slot(s) `c` reads (the `init`).
Refuses to match when `U`'s target registers are read again inside `B'`
*after* being written by something other than `U` (would indicate `U` isn't
actually isolated to the loop's update semantics).

## 5. Writer

Emits `for (init; c; U) { B' }`, lifting `init` from the preceding statement
and `U` from `B`'s tail, preserving comma-operator grouping when `U` spans
more than one independent write (as here: `i++, j--`).

## 6. Checker

Beyond stage-A default: asserts removing `init` from its original position
and `U` from the body tail doesn't change the statement count/side-effect
order of anything else in the enclosing block (i.e. `init`'s original
position had no other side-effecting statement between it and the loop, and
`U`'s tail position had nothing after it).

## 7. Version differences

**Confirmed at v99** (2026-08-30, for M5's `for-header` pass).
`tools/hermesc/v99/hermesc -O0 -dump-bytecode -pretty-disassemble=false
tests/fixtures/constructs/04-for-loop-basic/source.js`, `Function<global>`:

```
[@ 43] LoadConstZero 3<Reg8>                              ; i = 0   (init, before the loop)
[@ 45] StoreNPToEnvironment 4<Reg8>, 2<UInt8>, 3<Reg8>
[@ 49] LoadConstUInt8 3<Reg8>, 10<UInt8>                  ; j = 10  (init)
[@ 52] StoreNPToEnvironment 4<Reg8>, 3<UInt8>, 3<Reg8>
[@ 56] LoadFromEnvironment 3<Reg8>, 4<Reg8>, 2<UInt8>     ; i
[@ 60] LoadFromEnvironment 1<Reg8>, 4<Reg8>, 3<UInt8>     ; j
[@ 64] Less 3<Reg8>, 3<Reg8>, 1<Reg8>                     ; i < j
[@ 68] JmpFalse 83<Addr8>, 3<Reg8>                        ; pre-test, false -> exit
                                                          ; body: trace.push(i+':'+j) @71..105
[@ 108] LoadFromEnvironment 1<Reg8>, 4<Reg8>, 2<UInt8>
[@ 112] ToNumeric 1<Reg8>, 1<Reg8>
[@ 115] Inc 1<Reg8>, 1<Reg8>
[@ 118] StoreToEnvironment 4<Reg8>, 2<UInt8>, 1<Reg8>     ; i++  -- UPDATE, at the body tail
[@ 122] LoadFromEnvironment 1<Reg8>, 4<Reg8>, 3<UInt8>
[@ 126] ToNumeric 1<Reg8>, 1<Reg8>
[@ 129] Dec 1<Reg8>, 1<Reg8>
[@ 132] StoreToEnvironment 4<Reg8>, 3<UInt8>, 1<Reg8>     ; j--  -- second UPDATE (comma operator)
[@ 136] LoadFromEnvironment 1<Reg8>, 4<Reg8>, 2<UInt8>
[@ 140] LoadFromEnvironment 3<Reg8>, 4<Reg8>, 3<UInt8>
[@ 144] Less 1<Reg8>, 1<Reg8>, 3<Reg8>                    ; i < j  (RE-EVALUATED, back-edge test)
[@ 148] JmpTrue -77<Addr8>, 1<Reg8>                       ; -> back to the body
```

Instruction-for-instruction identical to v94 modulo register allocation and
the v≥97 explicit-environment register (`CreateTopLevelEnvironment` into r4
instead of the implicit `CreateEnvironment`): init hoisted above the pre-test,
pre-test `Less` + `JmpFalse`, both updates appended to the body tail, the
condition re-evaluated for the back edge. **No divergence.** The row is
therefore `✅ verified` at 94,99 and `src/passes/for-header/` may be — and now
is — implemented against it.

Not re-read at v84/v96/v98; v96 shares v94's opcode table and v98 shares v99's
(`docs/HBC-FORMAT.md`), and the decompiler recovers `for (` from
`04-for-loop-basic` at all five versions, which is the behavioural
cross-check (`tests/gate/passes/loop-cond.test.ts`).
