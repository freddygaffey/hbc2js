# `for-in` — `for (const k in obj)`

**Fixture:** `tests/fixtures/constructs/05-for-in-object.js`
**Confidence:** ✅ verified (v94 and v99 read, default `-O`)

This resolves an open question from `docs/specs/03-cfg.md` §3.4/§6.4 and
`docs/specs/07-pass-ladder.md` §4, both of which flagged the `for...in`
opcode family as "expected but not verified in this repo." **It is exactly
the family predicted: `GetPNameList` + `GetNextPName` + `JmpUndefined`.**

## 1. Source

```js
const keys = [];
for (const key in d) {
  keys.push(key);
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -dump-bytecode -pretty-disassemble=false`:

```
[@ 158] Mov 5<Reg8>, 1<Reg8>                              ; r5 = d (the object)
[@ 161] GetPNameList 6<Reg8>, 5<Reg8>, 4<Reg8>, 3<Reg8>    ; r6 = enumerator; r5=obj, r4/r3 = scratch (iter index, size)
[@ 166] JmpUndefined 27<Addr8>, 6<Reg8>                    ; no enumerable props at all -> EXIT (skips loop entirely)
L:                                                          ; loop header
[@ 169] GetNextPName 1<Reg8>, 6<Reg8>, 5<Reg8>, 4<Reg8>, 3<Reg8>  ; r1 = next key, or undefined
[@ 175] JmpUndefined 18<Addr8>, 1<Reg8>                    ; exhausted -> EXIT (SAME target as the [@166] jump)
[@ 178] Mov 8<Reg8>, 1<Reg8>                               ; key -> r8
[@ 181] GetByIdShort 7<Reg8>, 2<Reg8>, 7<UInt8>, 10<UInt8> ; keys.push
[@ 186] Call2 7<Reg8>, 7<Reg8>, 2<Reg8>, 8<Reg8>           ; keys.push(key)
[@ 191] Jmp -22<Addr8>                                     ; back to L
EXIT:
[@ 193] TryGetById ...                                     ; code after the loop
```

## 3. CFG/IR shape

Two-stage enumeration, both stages using `JmpUndefined` as the "exhausted"
signal (Hermes represents "no more properties" as the sentinel value
`undefined` flowing through the same register the key is returned in — not
a separate boolean/flag):
1. `GetPNameList dst, obj, idxScratch, sizeScratch` — builds the (own +
   inherited, enumerable-only, already-deduplicated per spec) property-name
   enumerator once, before the loop. If `dst` comes back `undefined`, there
   is nothing to enumerate and the loop is skipped entirely (a **separate**
   `JmpUndefined` from the one inside the loop body, both targeting the same
   exit block — a for-in loop therefore has, like `while`, a pre-test/guard
   distinct from its per-iteration test, but here the "test" is "did
   GetPNameList find anything" rather than a boolean condition).
2. `GetNextPName dst, enumerator, obj, idxScratch, sizeScratch` — one call
   per iteration, advancing the internal index scratch registers in place;
   `dst === undefined` ends the loop.

The loop body itself is an ordinary block; `idxScratch`/`sizeScratch` are
opaque to the source language (they never appear as JS values) and must be
excluded from any variable-recovery pass — they are pure enumerator state.

## 4. Matcher

Recognises: a `GetPNameList dst_e, obj, idx, size` immediately followed by
`JmpUndefined EXIT, dst_e`, whose fallthrough leads to a block starting with
`GetNextPName dst_k, dst_e, obj, idx, size; JmpUndefined EXIT, dst_k` (same
`EXIT` target as the guard), with the loop's back edge landing on the
`GetNextPName` block. Captures `dst_k` as the per-iteration binding
(`key` in the source). Refuses to match if `idx`/`size` are read or written
by anything other than `GetPNameList`/`GetNextPName` themselves (would
indicate hand-written code coincidentally using the same opcodes, which
should not happen in practice but the checker should not assume it can't).

## 5. Writer

Emits `for (const <name> in <obj>) { B }` (or `let`/no-binding-keyword
depending on how the per-iteration variable is otherwise used — that's
`expr-rebuild`'s job, not this pass's).

## 6. Checker

Beyond stage-A default: asserts both `JmpUndefined` guards target the exact
same block (a for-in loop has exactly one exit, reached from two different
"exhausted" checks).

## 7. Version differences

**Re-read at v99 (Static Hermes, `hbc99-mar2026` opcode table), 2026-09-05,
spec 21.** `hbc2js disasm tests/fixtures/constructs/05-for-in-object/v99.hbc`
against the v94 dump above: **the shape is identical**, opcode for opcode.

```
  008d  NewArray             r5, 0
  0091  Mov                  r6, r4
  0094  GetPNameList         r7, r6, r0, r1
  0099  JmpUndefined         L2, r7
L1:
  009c  GetNextPName         r4, r7, r6, r0, r1
  00a2  JmpUndefined         L2, r4
  00a5  Mov                  r9, r4
  00a8  GetByIdShort         r8, r5, #c6, s10 "push"
  00ad  Call2                r8, r8, r5, r9
  00b2  Jmp                  L1
L2:
```

Same five-operand `GetNextPName`, same two `JmpUndefined` guards targeting
the same exit `L2`, same back edge onto the `GetNextPName` block, both
occurrences in the fixture (the plain object loop and the
prototype-enumerable loop). The only v99 differences anywhere near the site
are unrelated to this idiom: `PutById` is spelled `PutByIdLoose`,
`NewObjectWithBuffer` carries a shape-table id, `GetGlobalObject` is
re-materialised per use, and the scratch pair `idx`/`size` happens to land
in `r0`/`r1` (the low constant registers) rather than `r4`/`r3`. **No
matcher change is needed between 94 and 99**; the operand *positions* are
what the matcher keys on, never the register numbers.

Versions 84/96/98 were not re-dumped: 94 and 99 bracket the two opcode
tables (`hbc94` and `hbc99-mar2026`) and the family is unchanged across
them, so an intermediate divergence is not physically possible without a
table entry that neither end has.
