# `for-of` — `for (const v of it)`

**Fixtures:** `06-for-of-array` (plain arrays, `break`), `07-for-of-iterable`
(Map/Set/custom `[Symbol.iterator]`)
**Confidence:** ✅ verified (v94 and v99 read, default `-O`)

This resolves the other open question from `docs/specs/03-cfg.md` §6.4 and
`docs/specs/07-pass-ladder.md` §4 (the "`Iterator*` family, likewise
unverified"). It is exactly `IteratorBegin`/`IteratorNext`/`IteratorClose`.

## 1. Source

```js
const arr = [10, 20, 30, 40, 50];
let sum = 0;
for (const v of arr) {
  sum += v;
  if (v === 30) { print('breaking at v=' + v); break; }
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -dump-bytecode -pretty-disassemble=false`:

```
[@ 26] Mov 5<Reg8>, 8<Reg8>                  ; r5 = arr
[@ 29] IteratorBegin 9<Reg8>, 5<Reg8>        ; r9 = iteration STATE (either a fast-path array index, or a real iterator object)
L:
[@ 32] IteratorNext 11<Reg8>, 9<Reg8>, 5<Reg8>  ; r11 = value; (state=r9, source=r5) — r9 updated in place
[@ 36] Mov 12<Reg8>, 9<Reg8>
[@ 39] JStrictEqual 54<Addr8>, 12<Reg8>, 3<Reg8>   ; state === undefined -> EXIT (exhausted)
[@ 43] Mov 6<Reg8>, 11<Reg8>                 ; v = value
... (sum += v; if (v===30) {...})
[@ 53] JStrictEqual 6<Addr8>, 11<Reg8>, 10<Reg8>   ; v === 30
[@ 57] Jmp -25<Addr8>                        ; back to L (no break)
[@ 59] TryGetById 10<Reg8>, 1<Reg8>, 1<UInt8>, 8<UInt16>   ; print('breaking...') -- the `break` body
[@ 76] Call2 ...
[@ 81] IteratorClose 9<Reg8>, 0<UInt8>       ; NORMAL close (arg = 0) on `break`
[@ 84] Jmp 9<Addr8>                          ; -> EXIT
EXCEPTION HANDLER for the loop body range:
[@ 86] Catch 5<Reg8>
[@ 88] IteratorClose 9<Reg8>, 1<UInt8>       ; ABRUPT close (arg = 1) before rethrowing
[@ 91] Throw 5<Reg8>
```

Destructuring an entry from an iterable-of-iterables (`for (const [k, v] of
map)`, `07-for-of-iterable`) reuses the **same** opcode pair one level
deeper — the per-entry array `[k, v]` yielded by the Map iterator is itself
consumed via a nested `IteratorBegin`/`IteratorNext` pair:

```
[@ 108] Mov 13<Reg8>, 11<Reg8>       ; the [k,v] pair just yielded by the outer for-of
[@ 111] IteratorBegin 10<Reg8>, 13<Reg8>
[@ 118] IteratorNext 14<Reg8>, 10<Reg8>, 13<Reg8>   ; -> k
... (a second IteratorNext for v)
```

## 3. CFG/IR shape

- `IteratorBegin dst, iterable` — one-time setup. Hermes uses a **dual
  representation** in `dst`: for a genuine array (fast path), it can be an
  internal index; for anything else, a real iterator object. This is opaque
  to the decompiler and must be treated as "iteration state," never
  unwrapped.
- `IteratorNext dst_val, state, source` — one call per iteration; advances
  `state` in place (same register). Exhaustion is signalled by `state`
  becoming `=== undefined` after the call — checked via an explicit
  `JStrictEqual` against a known-`undefined` register, **not** a
  `JmpUndefined` (unlike `for-in`'s `GetNextPName`, which uses
  `JmpUndefined` directly on the *value* register). This is a real,
  confirmed difference between the two iteration idioms, not an
  inconsistency to "fix" in a matcher — `for-in` and `for-of` must be
  matched independently.
- `IteratorClose state, isAbrupt<UInt8>` — called on **every** non-normal
  exit path: `break` (via a forward jump straight to a close-then-exit
  block, `isAbrupt=0`) and exception unwind (via a `Catch` block that
  protects the entire loop body, `isAbrupt=1`, followed by `Throw` to
  propagate). A `for-of` loop that runs to natural exhaustion does **not**
  call `IteratorClose` at all — only `break`/`return`/exception paths do,
  matching the iterator protocol's spec (`IteratorClose` is only required on
  abrupt completion).

## 4. Matcher

Recognises: `IteratorBegin dst_s, src` followed by a loop header
`IteratorNext dst_v, dst_s, src; <cmp> dst_s, <undefined-reg>; <cond-jump>
EXIT`, with the back edge on the header. Captures the exception region
covering the loop body whose handler is exactly `Catch r; IteratorClose
dst_s, 1; Throw r` as the abrupt-exit companion (not a user-written
`try`/`catch` — `try-catch.md`'s matcher must run *after* this one claims
the region, or must explicitly exclude compiler-synthesized for-of cleanup
handlers; see `docs/specs/07-pass-ladder.md` §5 for why this ordering must
be declared). Any forward jump to a block ending in `IteratorClose dst_s, 0`
before the loop's normal exit is a `break` (or, for a labelled case, see
`labeled-break-continue.md`).

## 5. Writer

Emits `for (const <name> of <src>) { B }`, dropping the synthesized
`IteratorClose`/`Catch`/`Throw` machinery entirely (it is implied by the
`for...of` statement form in JS and does not need to be represented).

## 6. Checker

Beyond stage-A default: asserts the `Catch`/`IteratorClose`/`Throw` region
being dropped has **no other reachable use** (i.e. it is exactly the
compiler-synthesized cleanup shape and not, coincidentally, code that also
runs on the normal path) — otherwise abandon the site and leave the
lower-level `try`/`catch` recovery to handle it.

## 7. Version differences

**Re-read at v99 (Static Hermes, `hbc99-mar2026` opcode table), 2026-09-05,
spec 21.** `hbc2js disasm` on `06-for-of-array/v99.hbc` and
`07-for-of-iterable/v99.hbc`. The **opcode family is unchanged** —
`IteratorBegin`/`IteratorNext`/`IteratorClose` with the same operand counts,
the same `JStrictEqual state, <undefined-reg>` exhaustion test, the same
`Catch; IteratorClose s, 1; Throw` handler, and the same `IteratorClose s, 0`
before a `break`'s jump to the exit. Two **register-plumbing** differences
matter to a matcher, and only to a matcher:

**(a) v99 refreshes the source operand through a `Mov` inside the loop
header, and reuses one register for value and source.**

```
                     v94                                   v99
  001d  IteratorBegin  r9, r5             0011  IteratorBegin  r4, r6
L1:                                       0014  LoadConstUInt8 r5, 30
  0020  IteratorNext   r11, r9, r5      L1:
  0024  Mov            r12, r9            0017  Mov            r7, r6
  0027  JStrictEqual   L4, r12, r3        001a  IteratorNext   r7, r4, r7
                                          001e  Mov            r8, r4
                                          0021  JStrictEqual   L4, r8, r3
```

At v94 `IteratorNext dst, state, src` names the very register
`IteratorBegin` was given. At v99 the source operand is a fresh copy made in
the header (`Mov r7, r6; IteratorNext r7, r4, r7`) and the destination
*aliases* it. A matcher that requires `next.src === begin.src`, or that
requires `next.dst !== next.src`, matches at 94 and refuses at 99. It must
resolve the source operand through header `Mov`s back to `begin.src`, and
must not assume the three operands are distinct.

**(b) v99 copies the state register before a normal `IteratorClose`.**

```
        v94                                  v99
  0051  IteratorClose  r9, 0          004d  Mov            r0, r4
  0054  Jmp            L4             0050  IteratorClose  r0, 0
                                      0053  Jmp            L4
```

The abrupt close in the handler is *not* copied at either version
(`Catch r0; IteratorClose r4, 1; Throw r0` at v99), so only the break-path
close needs the `Mov` walk-back.

Consequential but not shape-changing: v94's exception table carries **two**
`.try` ranges pointing at the one for-of handler (the protected range is
split around the `Jmp`), v99 carries **one**. A matcher must therefore accept
*one or more* ranges whose handler is the same block, never exactly one and
never exactly two.

`07-for-of-iterable` behaves identically at both versions, including the
nested `IteratorBegin`/`IteratorNext` pair that destructures the `[k, v]`
entry (four `IteratorBegin` sites at 94 and at 99); at v99 the nested pair
shows the same `Mov`-refreshed source operand as (a).

Versions 84/96/98 were not re-dumped, for the reason given in
`for-in.md` §7: 94 and 99 bracket both opcode tables.
