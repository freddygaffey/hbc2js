# `for-header` — `for (init; c; update) B`

**Fixture:** `tests/fixtures/constructs/04-for-loop-basic/source.js`
**Confidence:** ✅ single-version (v94 `-O0` only — needs a v99 cross-check before a pass may be written against it, per spec 07 §4)

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

Not yet checked against v99 — the fixture's v99 dump was not read for this
idiom specifically (v99 was used for `while-cond`, `switch`, and others, but
not re-verified here for the `for`-specific init/update placement). Given
`for` reuses the identical `while` rotation and v99 introduces no changes to
that rotation (per `while-loop.md` §7), no divergence is expected, but this
is a **single-version** finding per spec 07's rule and must be confirmed
before `src/passes/for-header/` is implemented.
