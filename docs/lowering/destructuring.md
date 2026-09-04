# Destructuring (array and object) — iterator protocol + `undefined`-check defaults

**Fixtures:** `37-destructuring-array`, `38-destructuring-object`,
`39-destructuring-params`
**Confidence:** ✅ single-version (v94, `-O0`)

## 1. Source

```js
const [a, b = 99, , d, ...rest] = [1, undefined, 'skipped', 4, 5, 6, 7];
const { a: renamedA, b: renamedB = 'default-b' } = { a: 1 };
```

## 2. Bytecode — array destructuring

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:

```
[@ 152] IteratorBegin 0<Reg8>, 5<Reg8>                    ; same opcode as for-of.md
[@ 164] IteratorNext 13<Reg8>, 1<Reg8>, 5<Reg8>           ; -> a
[@ 168] Mov 18<Reg8>, 1<Reg8>
[@ 171] StrictEq 18<Reg8>, 18<Reg8>, 10<Reg8>             ; state === undefined? (exhausted check, per-position)
[@ 178] JmpTrue 6<Addr8>, 18<Reg8>
[@ 181] Mov 3<Reg8>, 13<Reg8>
[@ 184] Mov 13<Reg8>, 3<Reg8>
[@ 187] StoreToEnvironment 7<Reg8>, 0<UInt8>, 13<Reg8>    ; a = value
...
[@ 200] IteratorNext 13<Reg8>, 1<Reg8>, 5<Reg8>           ; -> b (raw value, BEFORE default check)
...
[@ 223] StrictNeq 13<Reg8>, 13<Reg8>, 10<Reg8>            ; raw value !== undefined ?
[@ 227] JmpTrue 6<Addr8>, 13<Reg8>                         ; true -> skip the default, use the raw value
[@ 230] Mov 3<Reg8>, 4<Reg8>                                ; false -> use the default (99)
[@ 233] Mov 4<Reg8>, 3<Reg8>
[@ 236] StoreToEnvironment 7<Reg8>, 1<UInt8>, 4<Reg8>      ; b = (raw !== undefined) ? raw : 99
```

**Elided positions** (`, ,` — a hole) call `IteratorNext` (to advance the
iterator) but never store the result anywhere — confirmed by the absence of
any `StoreToEnvironment`/`Mov`-into-a-named-register between one
`IteratorNext` and the next for the skipped position. **Rest** (`...rest`)
switches to a plain loop building a real array via ordinary
`NewArray`/`PutOwnByIndex` in a tail loop that keeps calling `IteratorNext`
until exhaustion — the identical "drain the rest of an iterator into an
array" shape as `40-spread-array`'s `[...iterable]` (`spread-rest.md`).

**Object destructuring** (`38`) uses ordinary `GetByIdShort`/`GetByVal`
(for computed keys) instead of the iterator protocol — there is no
`ObjectPattern`-specific opcode; `{ a: renamedA, b: renamedB = 'default-b'
}` is exactly `renamedA = obj.a; renamedB = obj.b !== undefined ? obj.b :
'default-b';` in bytecode, using the **same** `StrictNeq undefined`
default-check idiom as the array case. Rest in an object pattern
(`const { x, ...others } = obj`) uses a `CallBuiltin` (the same
`CopyDataProperties`-shaped builtin as object spread, see
`spread-rest.md`) seeded with an object literal listing the **excluded**
keys (`x`), rather than a positional/count-based mechanism.

## 3. CFG/IR shape

Array destructuring is **entirely** the `for-of.md` idiom, applied once per
target position instead of once per loop iteration — no new CFG shape.
Default values are a plain two-way branch (`StrictNeq undefined; JmpTrue
skip`), structurally identical to `default-params.md`'s idiom — the same
matcher should serve both call sites. Object destructuring is ordinary
straight-line property access, sometimes with the same default-value branch.

## 4. Matcher

**Array**: recognises a sequence of `IteratorNext`/`Mov`/`Store*` groups
sharing one `IteratorBegin`, where a "hole" position is an `IteratorNext`
whose result is never stored, and a "default" position wraps its store in
the `StrictNeq undefined` branch. **Object**: recognises a
destructuring-shaped group of `GetByIdShort`/`GetByVal` immediately after a
single source value becomes live, one property read per binding, with the
same optional default-value branch. Both refuse to match when the
extracted values are used for anything other than immediate binding
(ordinary property/iterator access unrelated to a pattern looks identical
in isolation — this idiom is a *readability* recognition over already-
correct code, same caveat as `template-literals.md`).

## 5. Writer

Emits `const [a, b = 99, , d, ...rest] = <src>;` / `const { a: renamedA, b:
renamedB = 'default-b' } = <src>;`.

## 6. Checker

Beyond stage-B default: asserts the recovered pattern's evaluation order
matches the bytecode's actual instruction order (left-to-right,
iterator-protocol-driven for arrays) — destructuring patterns have
observable per-property evaluation order in JS and a matcher must not
reorder them for cosmetic reasons.

## 7. Version differences

Not cross-checked against v99 in this research pass (v94 `-O0` only); no
reason to expect a difference since this idiom is built entirely from
already-version-checked primitives (`for-of.md`'s iterator opcodes,
ordinary property access).

### v99 re-check (rung 16 implementation, docs/specs/passes/16-destructure.md §0)

Confirmed at v99 (`npx tsx src/cli.ts tests/fixtures/constructs/{37,38,39}-*/v99.hbc --no-pass var-naming --no-pass fn-naming`): the stage-B shape is **identical** to v94's — one labeled block per bound array element / defaulted object property, tail `break`, `GetById` fan-out for plain properties, 3-arg `copyDataProperties` for object rest. The only differences are cosmetic register-copy ones already generalised in spec 16 §2.6: the done-flag recompute is sometimes threaded through an extra `ident = ident` copy before *and* after the comparison that establishes it (handled by the matcher's `growEquivSet` — an equivalence *set*, not a single tracked name, since a later guard may legally test any name in it), and the `undefined`-sentinel operand's register number differs (never its shape). `default-params` does **not** fire on `38`'s/`39`'s `= {}` object-pattern parameter default at *either* version (see docs/BUGS.md's `destructure-v94-default-params-no-fire` row — spec 16 §2.6's v94 column claiming it already fired was measured wrong); this rung's object rule is unaffected either way, since it keys on the observed source register, not on how that register came to hold the value. Catalogue row 22 confidence promoted to ✅ verified on this basis.

### Holes and rest at function-body scope (rung 16 implementation, BUGS.md 2026-09-02)

Measured on a fresh fixture (`tests/fixtures/constructs/65-destructure-hole-rest`,
`skipMiddle(xs) { let a, c; [a, , c] = xs; return a + ':' + c; }` /
`headAndTail(xs) { let h, t; [h, ...t] = xs; return h + ':' + t.join(','); }`)
because `37-destructuring-array`'s own hole/rest positions are top-level and
already refused by `pc-tracked-region` before either shape can be observed
in isolation. Plain-assignment form (not `const`/`let [..] =`) is
deliberate: a *declaration*-form pattern at v84 fuses a TDZ init
(`r0 = __hbc_empty; r4 = r0; r3 = r0;`) into the array pattern's own
prologue block, which `parsePrologueBlock` does not parse — an unrelated,
pre-existing v84 `let`/`const` quirk this fixture sidesteps rather than
fixes.

**Hole** (`skipMiddle`'s `[a, , c]`): at v84/v94/v96 the elided middle
position is a labeled block indistinguishable in *shape* from a normal
element block — it stages its raw stepped value into a shared register and
ends with an unconditional `break`, exactly like a kept element in
staged-commit style (§2.1(b)). The only distinguishing fact is *use*: the
following block never reads that stage (it resets the same register fresh
instead of committing it), and the register is never read again anywhere
in the function. Two things this fixture is the first to exercise:

1. **A leading flag-copy before an element's own early guard**
   (`r7 = r2; if (r7) { break L1; }` — the element under test copies the
   previous block's done flag into a fresh register before testing it,
   where every previously-measured fixture tested the flag register
   directly). Cosmetic, the same family of register-copy noise §2.6
   documents elsewhere, just not previously observed at this position.
2. **The close block can itself carry the pattern's last position's
   commit** (`L3: { r3 = r5; r5 = r2; if (r5) { break L3; } … }` — `r3 = r5`
   commits the last kept element's staged value before the close block's
   own done-guard). `firstTwo`'s last element always committed directly
   inside its own block, so no fixture needed this before.

v98/v99 lower the *same* hole through a shape this rung does not parse: the
early guard's flag-copy target is *itself* aliased again to feed the
`iterNext` call's second argument directly (`r0 = r2; if (r0) …; r3 = r5;
__hbc_iterNext(r1, r3); …` — `r3`, not `r5`, is passed where the matcher
requires the tracked `rNextFn` register by name), and the stepped value is
never staged into any register at all before being overwritten by the next
comparison. The site stays refused (`broken-threading`), correctly.

**Rest** (`headAndTail`'s `[h, ...t]`): refused at **every** version,
including function-body scope — confirmed by counting `__pc` writes inside
`headAndTail`'s own printed body: 13 at v84/v94/v96, 3 at v98/v99, never
zero. Spec §2.4/§8 Q1 framed the rest loop's `try`/`catch` as a top-level-
module-wrapper artifact; this measurement shows it is inherent to the rest
lowering itself (the append loop's own `IteratorClose(it, true)` abrupt-path
handler), present regardless of nesting depth. Array rest therefore has no
reachable v1 site at all, not merely a top-level one — it stays exactly
where spec §8 Q1 already put it, a batch-4 `try-clean` follow-up, now with
direct evidence rather than an inference from the top-level case alone.
