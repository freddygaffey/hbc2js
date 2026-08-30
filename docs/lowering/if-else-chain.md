# `if-else-chain` — `if`/`else if`/`else`

**Fixture:** `tests/fixtures/constructs/01-if-else-chain/source.js`
**Confidence:** ✅ verified (v84, v94, v98, v99 — all four dumped, all identical in shape)

## 1. Source

```js
function check(n) {
  if (log.push('check(' + n + ')') && n < 0) {
    return 'negative';
  } else if (n === 0) {
    return 'zero';
  } else if (n < 10) {
    return 'small';
  } else if (n < 100) {
    return 'medium';
  } else {
    return 'large';
  }
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -dump-bytecode -pretty-disassemble=false`, default `-O`:

```
Function<check>(2 params, 13 registers, 0 symbols):
[@ 0] LoadParam 1<Reg8>, 1<UInt8>
[@ 3] GetEnvironment 0<Reg8>, 0<UInt8>
[@ 6] LoadFromEnvironment 3<Reg8>, 0<Reg8>, 0<UInt8>
[@ 10] GetByIdShort 2<Reg8>, 3<Reg8>, 1<UInt8>, 14<UInt8>
[@ 15] LoadConstString 0<Reg8>, 3<UInt16>
[@ 19] Add 4<Reg8>, 0<Reg8>, 1<Reg8>
[@ 23] LoadConstString 0<Reg8>, 1<UInt16>
[@ 27] Add 0<Reg8>, 4<Reg8>, 0<Reg8>
[@ 31] Call2 0<Reg8>, 2<Reg8>, 3<Reg8>, 0<Reg8>
[@ 36] JmpFalse 9<Addr8>, 0<Reg8>          ; !push(...) -> skip to "n<0" test
[@ 39] LoadConstZero 0<Reg8>
[@ 41] JLess 48<Addr8>, 1<Reg8>, 0<Reg8>   ; n<0 false -> "n===0" block
[@ 45] LoadConstZero 0<Reg8>
[@ 47] JStrictEqual 36<Addr8>, 1<Reg8>, 0<Reg8>  ; n===0 false -> "n<10" block
[@ 51] LoadConstUInt8 0<Reg8>, 10<UInt8>
[@ 54] JLess 23<Addr8>, 1<Reg8>, 0<Reg8>   ; n<10 false -> "n<100" block
[@ 58] LoadConstUInt8 0<Reg8>, 100<UInt8>
[@ 61] JLess 10<Addr8>, 1<Reg8>, 0<Reg8>   ; n<100 false -> "else" block
[@ 65] LoadConstString 0<Reg8>, 5<UInt16>  ; ('negative') -- fallthrough of the FIRST if
[@ 69] Ret 0<Reg8>
[@ 71] LoadConstString 0<Reg8>, 6<UInt16>  ; 'zero'
[@ 75] Ret 0<Reg8>
[@ 77] LoadConstString 0<Reg8>, 9<UInt16>  ; 'small'
[@ 81] Ret 0<Reg8>
[@ 83] LoadConstString 0<Reg8>, 10<UInt16> ; 'medium'
[@ 87] Ret 0<Reg8>
[@ 89] LoadConstString 0<Reg8>, 7<UInt16>  ; 'large'
[@ 93] Ret 0<Reg8>
```

Every version (v84/94/98/99) at both `-O` and `-O0` produces the identical
shape modulo register numbers and the compound-condition prelude — this is
already extremely close to the source structure and is the simplest idiom
in the catalogue.

## 3. CFG/IR shape

A linear chain of conditional-jump blocks, each with two successors: "fall
through to next test" (branch-not-taken) and "jump to this arm's body"
(branch-taken, forward jump). Every arm's body ends in `Ret` (or, without an
early return, a forward `Jmp` to a shared join block — not exercised by this
fixture but seen in `10-switch-no-fallthrough`). No back edges. This is
exactly Ramsey's "linear region" case (D7) — no loop, no irreducibility
question.

**Important direction note:** Hermes/terser-style front ends compile `if (c)
A else B` by testing the **negation** and jumping *forward over A* when the
negation holds (`JmpFalse`/`JLess`/`JStrictEqual` with the *false* case as
the jump target and the *true* case as fallthrough) — i.e. the bytecode's
fallthrough path is the `if`-true arm, and the jump target is `else`. An
`if`/`else if` chain is therefore a sequence of blocks where the "false"
arm of block N is block N+1's test, not a nested structure — the nesting is
implicit in address order, not in any CFG feature. A matcher must reconstruct
`else if` from "the false-target of a conditional jump is itself the leader
of another conditional jump," not from any explicit marker.

## 4. Matcher

Recognises: a chain of blocks `B0..Bn` where each `Bi` (i<n) ends in exactly
one conditional jump whose **not-taken** edge leads to `Bi+1`'s leader, and
whose **taken** edge leads to a block that terminates the chain (`Ret`, or a
`Jmp` to a common join block). Deliberately does **not** match:
- a false-arm that leads somewhere *other* than the next test block's leader
  (that is a different control-flow shape, not an `else if`);
- a chain whose blocks are not contiguous in address order (this fixture
  never exercises that, but obfuscated/reordered input might — see
  `obfuscated-control-flow.md`).

## 5. Writer

Emits `if (c0) { body0 } else if (c1) { body1 } else ... else { bodyN }`,
inverting each comparison back from the bytecode's negated form (`JLess` on
the false-edge means the source condition was `<`, not `>=`).

## 6. Checker

Beyond the stage-A default (edges preserved): asserts every arm's body has
exactly one entry (from its own test) and that the join point (return or
common successor) is identical for every arm that doesn't return locally.

## 7. Version differences

None found. v84, v94, v98, v99 all produce byte-for-byte identical
*instruction sequences* for `check`'s body (only the string-table indices
differ, which is expected — string tables are per-file). This is the one
idiom in the corpus with zero version sensitivity.
