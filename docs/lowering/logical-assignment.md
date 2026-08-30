# Logical assignment (`&&=`, `||=`, `??=`)

**Fixture:** none — no construct fixture in `tests/fixtures/constructs/`
exercises these operators (checked: `grep -rl '&&=\|||=\|??=' source.js`
across the whole corpus returns nothing). This file is built from an ad hoc
probe file, exactly analogous to `switch.md`'s `StringSwitchImm` section
and spec 07 §12 O-3 — **a pass must not be implemented against this row
until a real fixture exists** (spec 07 §4).
**Confidence:** ⛔ inferred (ad hoc probe, v94 and v99)

## 1. Source (probe, not a fixture)

```js
function f(o) {
  o.a ||= 1;
  o.b &&= 2;
  o.c ??= 3;
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:

```
[@ 22] LoadFromEnvironment 10<Reg8>, 3<Reg8>, 0<UInt8>    ; o
[@ 26] GetByIdShort 11<Reg8>, 10<Reg8>, 1<UInt8>, 1<UInt8> ; o.a
[@ 34] JmpTrue 12<Addr8>, 0<Reg8>                          ; a is truthy -> SKIP the store (||= short-circuits)
[@ 37] PutById 10<Reg8>, 5<Reg8>, 1<UInt8>, 1<UInt16>      ; o.a = 1

[@ 46] LoadFromEnvironment 4<Reg8>, 3<Reg8>, 0<UInt8>
[@ 50] GetByIdShort 11<Reg8>, 4<Reg8>, 2<UInt8>, 2<UInt8>  ; o.b
[@ 58] JmpFalse 12<Addr8>, 1<Reg8>                          ; b is falsy -> SKIP the store (&&= short-circuits)
[@ 61] PutById 4<Reg8>, 6<Reg8>, 2<UInt8>, 2<UInt16>       ; o.b = 2

[@ 70] LoadFromEnvironment 11<Reg8>, 3<Reg8>, 0<UInt8>
[@ 74] GetByIdShort 12<Reg8>, 11<Reg8>, 3<UInt8>, 3<UInt8> ; o.c
[@ 79] Eq 13<Reg8>, 12<Reg8>, 7<Reg8>                       ; o.c == null   (r7 = LoadConstNull)
[@ 86] JmpFalse 12<Addr8>, 13<Reg8>                         ; NOT nullish -> SKIP the store (??= short-circuits)
[@ 89] PutById 11<Reg8>, 8<Reg8>, 3<UInt8>, 3<UInt16>      ; o.c = 3
```

At v99 the same shape reproduces (`JmpTrue`/`JmpFalse`/`PutById` count
unchanged, spot-checked by instruction-count `grep`, not a full re-read).

## 3. CFG/IR shape

Exactly `optional-chaining.md`'s short-circuit branch shape, reused for the
*store* side rather than the *read* side: read the current value, test it
(`JmpTrue` for `||=`, `JmpFalse` for `&&=`, `Eq null`+`JmpFalse` for `??=`),
and conditionally execute a plain assignment. No new opcode of any kind —
this is composed entirely from idioms already covered elsewhere in this
catalogue (`GetByIdShort`+conditional branch+`PutById`).

## 4. Matcher (hypothesis only — do not implement)

Would recognise: a property/variable read immediately tested by
`JmpTrue`/`JmpFalse`/`Eq null+JmpFalse` whose only reachable effect on the
taken path is skipping a single subsequent write to the *same*
property/variable the read came from. This is presented only as a
starting hypothesis; a real fixture may reveal call-expression targets
(`o.m() ||= ...` is invalid JS, but computed-member targets `o[k] ||= v`
are not, and were not probed) or other shapes this ad hoc single-property
probe doesn't cover.

## 5–6. Writer / Checker

Not specified — spec 07 §4 forbids implementing a pass against a ⛔ row.

## 7. Version differences

Not meaningfully checked — only an instruction-count spot-check at v99, no
full re-read.

## Recommendation

Add a `logical-assignment` construct fixture (`54-logical-assignment/`,
following the existing numbering) covering property targets, plain-variable
targets, and (if valid) computed-member targets, at v84/94/98/99, before
any pass claims this row. Analogous to spec 07 §12 O-3's recommendation for
`StringSwitchImm`.
