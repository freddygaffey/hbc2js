# Spread (array/call) and rest parameters

**Fixtures:** `40-spread-array`, `41-spread-object`, `42-rest-params`
**Confidence:** ✅ verified (v94 and v99 — see §7)

## 1. Source

```js
const b = [0, ...a, 4, ...a, 5];
print(sum3(...a));
const merged = { ...defaults, ...overrides };
function combine(first, ...rest) { ... }
```

## 2. Bytecode

**Array spread** (in a literal or a call's argument list) reuses the
`for-of.md` iterator triple verbatim: `IteratorBegin`/`IteratorNext` drain
the spread source into consecutive `PutOwnByIndex` calls on the array being
built (for a literal) or into consecutive argument-register `Mov`s (for a
call). Confirmed identical opcodes to `06-for-of-array`, just without a
`for` statement wrapping them — the loop shape (header + back edge +
exhaustion check) is present but was elided from an ordinary `for...of` by
the compiler; it's the same idiom, this file exists mainly to record that
array spread does **not** get its own opcode, it's the iterator idiom
applied inline.

**Object spread** (`{ ...defaults, ...overrides }`) is a genuinely
different idiom — **no iterator protocol at all**:
```
[@ 101] NewObject 15<Reg8>                                  ; the RESULT object, empty
[@ 103] LoadFromEnvironment 16<Reg8>, 0<Reg8>, 0<UInt8>     ; defaults
[@ 113] CallBuiltin 17<Reg8>, 44<UInt8>, 3<UInt8>           ; merge defaults's OWN enumerable props into r15
[@ 117] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 1<UInt8>     ; overrides
[@ 127] CallBuiltin 18<Reg8>, 44<UInt8>, 3<UInt8>           ; merge overrides's OWN enumerable props into r15 (LATER = WINS)
```
One `CallBuiltin` per `...spread` segment in the object literal, each
merging one source object's own enumerable properties into the
already-under-construction result — this directly implements "later key
wins" (each merge overwrites keys the previous merge set) without any
special-case ordering logic needed at the IR level; source order in the
literal is exactly bytecode order. **The builtin index is
version-dependent** (`docs/HBC-FORMAT.md` §11.4 — this project's own v94
build resolved index 44 for this specific builtin at this specific call
site; do not assume 44 is stable across versions or even across builds of
the same version without re-checking the builtin table) — behaviourally it
matches `CopyDataProperties`. `{ ...null, ...undefined, y: 1 }` (spreading
a nullish value is a no-op per spec) was not traced to confirm whether the
builtin itself no-ops on a nullish source or whether `hermesc` special-cases
it earlier — flagged as unconfirmed.

**Rest parameters** (`function combine(first, ...rest) {}`) build `rest` as
an ordinary real array via a small loop reading `arguments`-family opcodes
(`arguments-object.md`'s `GetArgumentsLength`/`GetArgumentsPropByVal`) for
indices beyond the declared named parameters, then `PutOwnByIndex`-ing them
into a fresh array — **not** the iterator protocol (there is no "iterable"
to iterate; the source is the raw argument list), and **not** entangled
with whether the function *also* has a live, separately-reified `arguments`
object (confirmed coexisting without conflict in `42-rest-params`'s
`combine`, which uses both `rest` and `arguments.length`).

## 3. CFG/IR shape

Array spread: no new shape, `for-of.md`'s loop inlined without a
source-level `for` statement wrapping it. Object spread: straight-line,
one `CallBuiltin` per spread segment, no control flow. Rest params: a
small bounded loop over `GetArgumentsPropByVal` (idiom shared with
`arguments-object.md`), building an array.

## 4. Matcher

**Array spread**: recognises an inlined `for-of.md` iterator-drain loop
feeding sequential `PutOwnByIndex`/argument-`Mov`s with no corresponding
source-level loop statement — i.e. the loop's body has no other observable
effect than appending to one target. **Object spread**: recognises a
`NewObject` immediately followed by N `CallBuiltin`s to the
"CopyDataProperties-shaped" builtin (identified by behaviour/signature —
version-dependent index — not by a fixed number), each merging a fresh
operand. **Rest**: recognises the bounded `GetArgumentsPropByVal` drain
loop building an array, keyed to the function's declared parameter count
(the loop starts at that index).

## 5. Writer

Emits `[0, ...a, 4, ...a, 5]` / `f(...a)` / `{ ...defaults, ...overrides }`
/ `function combine(first, ...rest) {}` respectively, dropping the
iterator/builtin machinery entirely.

## 6. Checker

Object spread: asserts merge order in the emitted literal matches
`CallBuiltin` call order exactly (later-wins semantics are order-dependent
and must not be reordered for cosmetic reasons).

## 7. Version differences

Confirmed at v99 (`docs/specs/passes/17-spread-rest.md` implementation task,
2026-09-02): decompiler output for `40`/`41`/`42` at `--no-pass var-naming
--no-pass fn-naming` shows identical stage-B shapes to v94 — the same
`__hbc_b_arraySpread`/`__hbc_b_apply`/`__hbc_b_copyRestArgs`/2-arg
`__hbc_b_copyDataProperties` helper calls in the same statement
arrangements, differing only in `expr-rebuild` residue (how many single-use
register copies survive before this rung runs, e.g. H1b's argument-array
build going through `r13`/`r12`/`r11` scratch copies at both versions in
`variadicSum(...a, ...b)`). This confirms row 23's own note: the object
builtin's *index* is version-dependent at the bytecode level, but `src/emit`
already resolved that to the version-uniform `__hbc_b_copyDataProperties`
name before this rung (stage B) ever sees it — so `spread-rest` itself is
one matcher for every HBC version, with no version branch anywhere in
`src/passes/spread-rest/`.

**Known gap, not a stage-B shape difference (`docs/BUGS.md`, 2026-09-02
row, shared with `default-params`'s v99 finding):** at v98/v99, `42`'s
`combine`/`restOnly` are emitted as orphan top-level function statements
("no closure creation site was found") rather than as members of `fn#0`'s
own body list — the same `src/emit/index.ts` orphan-assembly gap that
already blocks `default-params` from reaching those functions' `params`.
`spread-rest`'s S3 rule needs the exact same "list containing the `func`
statement" site `default-params` needs, so it inherits the same miss:
`__hbc_b_copyRestArgs` survives unrewritten in those two functions at
v98/v99 only. The trace-oracle verdict is unaffected (still valid,
correct JS); this is a readability miss, not a correctness bug. Fixed by
the same framework fix docs/BUGS.md asks for.
