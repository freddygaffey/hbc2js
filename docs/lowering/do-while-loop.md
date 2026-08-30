# `do-while` — `do B while (c)`

**Fixture:** `tests/fixtures/constructs/03-do-while-loop/source.js`
**Confidence:** ✅ verified (v94, v99 `-O0`; identical shape)

## 1. Source

```js
let n = 100;
let iterations = 0;
do {
  iterations++;
  n = n - 30;
} while (n > 0);

let x = 999;
do {
  print('body runs even though condition is false: x=' + x);
} while (false);
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:

```
L:                                                       ; loop body leader — NO pre-test at all
[@ 76] LoadFromEnvironment 2<Reg8>, 0<Reg8>, 1<UInt8>    ; iterations
[@ 80] ToNumeric 15<Reg8>, 2<Reg8>
[@ 83] Inc 16<Reg8>, 15<Reg8>
[@ 86] StoreToEnvironment 0<Reg8>, 1<UInt8>, 16<Reg8>    ; iterations++
[@ 93] LoadFromEnvironment 17<Reg8>, 0<Reg8>, 0<UInt8>   ; n
[@ 97] Sub 18<Reg8>, 17<Reg8>, 4<Reg8>
[@ 101] StoreToEnvironment 0<Reg8>, 0<UInt8>, 18<Reg8>   ; n = n - 30
[@ 108] LoadFromEnvironment 2<Reg8>, 0<Reg8>, 0<UInt8>
[@ 112] Greater 15<Reg8>, 2<Reg8>, 3<Reg8>               ; n > 0
[@ 116] JmpTrue -40<Addr8>, 15<Reg8>                     ; single trailing test -> back to L
                                                          ; (falls through here on exit — no extra Jmp needed)
```

Second `do { ... } while (false)`, `x = 999` case:

```
[@ 119] TryGetById ...                     ; print('body runs...')
[@ 150] Call ...
[@ 154] Mov 14<Reg8>, 19<Reg8>
[@ 157] StoreNPToEnvironment 0<Reg8>, 2<UInt8>, 8<Reg8>
...
[@ 185] Mov 14<Reg8>, 17<Reg8>
[@ 188] JmpTrue -27<Addr8>, 10<Reg8>       ; r10 = LoadConstFalse from function prologue
```

## 3. CFG/IR shape

The purest possible loop shape: `L: B; if (c) goto L;` — a single block
(or block chain) ending in one conditional back edge, **no pre-test, no
duplicate condition, no extra exit jump** (control simply falls through to
the next statement when the test is false). This is the shape every other
loop form (`while`, `for`) is built *from* — `while`/`for` add a pre-test
that `do-while` completely lacks, which makes `do-while` the more primitive,
not the more complex, loop idiom in the bytecode.

**Dead-condition finding.** `do { print(...) } while (false)` compiles its
`false` literal to a real register (`LoadConstFalse r10`) and the back edge
is a genuine `JmpTrue r10` instruction — **Hermes does not constant-fold
away a statically-false loop condition, even at `-O0`, and even at default
`-O`** (confirmed identical in the `-O` dump). The loop body still runs
exactly once, correctly, but the "loop" control-flow shape (a back-edge test
against a provably-constant register) remains in the bytecode for the
decompiler to see. A matcher must not assume "a `do-while` back edge is
always a live conditional" — it can be a dead one that a later
constant-folding pass (not yet in the ladder) would need to simplify to a
plain block.

## 4. Matcher

Recognises: a block (or block chain) `L` whose sole back edge is a
conditional jump `JmpTrue`/`JGreater`/etc. targeting `L`'s own leader, with
**no** edge into `L` from any block that evaluates the same condition before
`L` runs (that would indicate the block is actually a `while`/`for` body,
handled by those idioms' matchers, which should run first or claim the site
first — see `docs/specs/07-pass-ladder.md` §5 for why ordering constraints
must be declared). Deliberately does not match when the back-edge condition
register is defined by a **different** instruction sequence than any prior
evaluation in the block (this is normal for `do-while` — there is only ever
one evaluation, unlike `while`/`for`'s duplicated evaluation) — this
absence-of-duplication is itself the discriminator between `do-while` and
`while`.

## 5. Writer

Emits `do { B } while (c)`, with `c` taken directly from the back-edge
condition (no inversion needed, unlike `while-cond` — `do-while`'s condition
polarity in the bytecode already matches the source's).

## 6. Checker

Asserts `L` has no OTHER incoming edge that pre-tests the same condition
(disambiguates from `while-cond`/`for-header`, which must claim their sites
first per the ordering constraint above).

## 7. Version differences

None in the block shape. v99's `-O0` dump shows `CreateTopLevelEnvironment`
in place of `CreateEnvironment` (the v≥97 explicit-env family, per
`docs/specs/03-cfg.md` §3.5) but the loop body/back-edge instructions are
otherwise identical modulo register numbers.
