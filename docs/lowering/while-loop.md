# `while-cond` — `while (c) B`

**Fixture:** `tests/fixtures/constructs/02-while-loop/source.js`
**Confidence:** ✅ verified (v94 `-O0` and `-O`; v99 `-O0` cross-checked, identical shape)

## 1. Source

```js
let i = 0;
let sum = 0;
while (i < 100) {
  i++;
  const computed = (i * i) % 17;
  if (computed === 0 && i > 1) {
    print('breaking at i=' + i + ' computed=' + computed);
    break;
  }
  sum += i;
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`
(canonical/unoptimized shape — clearest 1:1 mapping to source):

```
[@ 71] LoadFromEnvironment 15<Reg8>, 0<Reg8>, 0<UInt8>   ; i
[@ 75] Less 16<Reg8>, 15<Reg8>, 7<Reg8>                  ; i < 100
[@ 79] JmpFalseLong 136<Addr32>, 16<Reg8>                ; PRE-TEST: false -> exit loop entirely
L:                                                        ; loop body leader
[@ 85] LoadFromEnvironment 15<Reg8>, 0<Reg8>, 0<UInt8>
[@ 89] ToNumeric 16<Reg8>, 15<Reg8>
[@ 92] Inc 17<Reg8>, 16<Reg8>                            ; i++
...(computed = i*i % 17; if (computed===0 && i>1) { print+break })...
[@ 156] StoreToEnvironment 0<Reg8>, 1<UInt8>, 17<Reg8>    ; sum += i
[@ 163] LoadFromEnvironment 15<Reg8>, 0<Reg8>, 0<UInt8>
[@ 167] Less 16<Reg8>, 15<Reg8>, 7<Reg8>                 ; i < 100 (RE-EVALUATED)
[@ 171] JmpTrue -86<Addr8>, 16<Reg8>                     ; POST-TEST: true -> back to L
[@ 174] Jmp 41<Addr8>                                     ; fallthrough exit -> join with `break`'s target
```

At default `-O` (v94), the same shape survives register allocation and
constant propagation (`i`/`sum` become plain registers instead of environment
slots because nothing captures them in a closure), but the **double
evaluation of the condition** is unchanged — see the `[@40]`/`[@147]`
`JLess`/back-edge pair in the disassembly captured during T3 research.

## 3. CFG/IR shape

`while (c) B` is **rotated** into `if (!c) goto EXIT; L: B; if (c) goto L; EXIT:`
— i.e. two copies of the condition-evaluating instructions: one before the
loop (guard) and one at the end of the body (back edge). This is done by
Hermes's IRGen itself, not by the optimizer — it is present at `-O0`. A
`break` inside `B` and the guard's false-edge are **different edges that
target the same block** (`EXIT`), confirmed here: the guard's `JmpFalseLong`
targets offset 136+79=215 (absolute), and `break`'s own jump plus the
back-edge's fallthrough (`[@174] Jmp 41` -> absolute 215) land at the same
place.

In CFG terms: entry block ends in a conditional edge (`branch-not-taken` →
EXIT, `branch-taken` → loop header L); L...back-edge-block ends in a
conditional edge (`branch-taken` → L, i.e. a genuine back edge per D7's
definition, `branch-not-taken` → falls through to a `Jmp` that also targets
EXIT). `break` inside the body is a forward edge straight to EXIT, bypassing
both tests.

## 4. Matcher

Recognises: a header block `H` ending in a conditional jump on condition `c`
(not-taken → `EXIT`, taken → `L`), where `L` dominates a "latch" block that
re-evaluates the **same** condition `c` (by structural/register-value
equality, not just syntactic opcode equality — the re-evaluation uses freshly
loaded operands) and branches back to `L` on true, falling through to a `Jmp
EXIT` on false. Refuses to match:
- a header whose guard condition is **not** re-evaluated verbatim at the
  latch (that is a `for`-with-different-update shape or hand-written
  duplication, not the compiler's `while` rotation);
- any case where `H` has side-effecting instructions between the environment
  loads and the comparison (must confirm before matching — this fixture's
  `H` is side-effect-free, but a `while (fn())` fixture is not yet in the
  gate corpus; treat as unconfirmed for that variant).

## 5. Writer

Emits `while (c) { B }`, dropping the duplicated tail test (it is
redundant with the header guard once structured as a genuine `while`).

## 6. Checker

Beyond the stage-A default: asserts the header's condition-computation
instructions and the latch's condition-computation instructions are
isomorphic (same opcode sequence up to register renaming) — if the compiler
ever CSEs the two evaluations into one shared block (not observed in any
fixture here, but plausible at higher optimization on a future Hermes), the
matcher must not fire because there would then be only one evaluation to
remove, not two.

## 7. Version differences

None in the rotation shape itself. v99's `-O0` dump (`AddN`/`MulN` in place
of `Add`/`Mul`, `CreateTopLevelEnvironment` in place of `CreateEnvironment`)
differs only in the numeric-specialised opcode names introduced ≥v97 and in
the environment-creation opcode family — the loop's block/jump shape is
identical. `JmpFalseLong` vs `JmpFalse`/`JmpTrue` is purely a function of
branch distance (Addr8 vs Addr32 encoding, spec see `docs/HBC-FORMAT.md`
§11.1), not a version difference.
