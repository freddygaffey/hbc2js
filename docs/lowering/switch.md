# `switch-raise` — `switch` (compare chain / `SwitchImm` / `StringSwitchImm`)

**Fixtures:** `09-switch-fallthrough`, `10-switch-no-fallthrough`,
`52-switch-jumptable`, `53-switch-jumptable-large`
**Confidence:** ✅ verified (compare chain, `SwitchImm`/`UIntSwitchImm` and — since T9 — `StringSwitchImm`, all
four versions); ⛔ inferred (`StringSwitchImm` — ad hoc probe file, not a
fixture; see catalogue O-3)

Hermes emits **three different bytecode idioms** for `switch`, chosen
per-`switch` by the compiler based on case density/type, not by HBC version
alone (though the *available* idioms are version-gated). A matcher must
handle all three and must not assume version implies idiom.

## 1. Source

Compare chain (`09-switch-fallthrough`, mixed integer cases with
fallthrough and a mid-list `default`):
```js
switch (n) {
  case 1:
  case 2: out.push('one-or-two');
  case 3: out.push('through-three'); break;
  default: out.push('default-hit');
  case 100: out.push('through-hundred'); break;
  case 4: out.push('four');
}
```

Dense table (`52-switch-jumptable`, cases `0..12` contiguous):
```js
switch (n) {
  case 0: ... break;
  case 1: case 2: ... break;
  ...
  case 12: ... break;
  default: ...
}
```

String switch (ad hoc probe, ≥20 distinct string cases — no fixture ships
this; `09`'s and `10`'s cases are numeric, and adding a real fixture is
tracked as spec 07 §12 O-3):
```js
function classify(s) {
  switch (s) { case 'a': return 0; case 'bb': return 1; /* ...20 cases... */ default: return -1; }
}
```

## 2. Bytecode

### 2a. Compare chain — `09-switch-fallthrough`, `classify`, v94 **and** v99 (identical)

```
[@ 7] LoadConstUInt8 0<Reg8>, 1<UInt8>
[@ 10] JStrictEqual 80<Addr8>, 0<Reg8>, 1<Reg8>   ; n===1 -> case-1/2 body
[@ 14] LoadConstUInt8 0<Reg8>, 2<UInt8>
[@ 17] JStrictEqual 73<Addr8>, 0<Reg8>, 1<Reg8>   ; n===2 -> case-1/2 body (SAME target as n===1: fallthrough group)
[@ 21] LoadConstUInt8 0<Reg8>, 3<UInt8>
[@ 24] JStrictEqual 80<Addr8>, 0<Reg8>, 1<Reg8>   ; n===3 -> SAME target as n===1/2! (case 3 falls into case1/2's body... )
[@ 28] LoadConstUInt8 0<Reg8>, 100<UInt8>
[@ 31] JStrictEqual 43<Addr8>, 0<Reg8>, 1<Reg8>   ; n===100
[@ 35] LoadConstUInt8 0<Reg8>, 4<UInt8>
[@ 38] JStrictEqual 20<Addr8>, 0<Reg8>, 1<Reg8>   ; n===4
                                                    ; falls through here = DEFAULT body
```
(Body blocks then chain into each other via `Jmp` to implement the source's
`break`-free fallthrough between `case 1/2` and `case 3`; see full dump in
the T3 research transcript for the complete body chain.) One `JStrictEqual`
(or `JStrictEqualLong` for far targets) per `case` label, tested in **source
order**, `default`'s body is simply the final fallthrough with no test of
its own — confirmed by `10-switch-no-fallthrough` and `09` both placing
`default` mid-list in source and having its body reached only by falling
through the last failed compare, never by a dedicated test.

### 2b. `SwitchImm` — `52-switch-jumptable`, `classify`, v84/v94

```
[@ 4] SwitchImm 0<Reg8>, 253<UInt32>, 223<Addr32>, 0<UInt32>, 12<UInt32>
     ; operands: Reg8 scrutinee, tableOffset, defaultTarget, min, max
...
 Jump Tables:
  offset 253
   0 : 207    (relative targets, one int32 per case value min..max, from the switch's own pc)
   1 : 191
   2 : 191    ; two consecutive table slots -> SAME target = the `case 1: case 2:` fallthrough group
   ...
   12 : 18
```

### 2c. `UIntSwitchImm` — same fixture/source, v98/v99

```
[@ 7] UIntSwitchImm 0<Reg8>, 253<UInt32>, 223<Addr32>, 0<UInt32>, 12<UInt32>
```
**Identical operand shape and identical table**, only the mnemonic changed.

### 2d. `StringSwitchImm` — `56-switch-string-jumptable`, `classify` (24 string cases), v98/v99 only

```
[@ 3] StringSwitchImm 1<Reg8>, 0<UInt32>, 125<UInt32>, 117<Addr32>, 20<UInt32>
      ; header: "StringSwitchImm count: 1" in the file summary
```
At v84/v94, the **same source** (20 string cases) still compiles to a
`JStrictEqualLong` compare chain (`StringSwitchImm count: 0`) — this opcode
does not exist before v98. **Corrects spec 07 §4's claim that this is a
"v99" idiom: it is available starting at v98.** With only 3 string cases
(`tests/fixtures/constructs`'s style of small switch), v99 still uses a
plain compare chain — `StringSwitchImm` has its own case-count threshold,
just like `SwitchImm`'s density threshold, and a matcher cannot assume
"string switch at v98+" always means `StringSwitchImm`.

**✅ Measured (T9, 2026-08-30), fixture not probe.**
`56-switch-string-jumptable` is now a committed fixture, compiled at all five
versions, and the opcode counts across its whole module are:

| version | `StringSwitchImm` | `JStrictEqual` |
|---|---|---|
| 84 | 0 | 28 |
| 94 | 0 | 28 |
| 96 | 0 | 28 |
| 98 | **1** | 4 |
| 99 | **1** | 4 |

Two things fall out of the counts. The v96→v98 boundary is confirmed on a real
fixture, not a probe. And the residual 4 `JStrictEqual` at v98/v99 are the
*second* switch in the same file — `bucket`, six cases collapsing to three
bodies — which stays a compare chain at every version. So one module can carry
both lowerings at once, and a matcher must decide per switch, never per file or
per version.

The fixture passes the gate at all five versions (5 PASS, 0 DIVERGENT).

## 3. CFG/IR shape

- **Compare chain**: an ordinary `if-else-chain`-shaped sequence of
  conditional edges, EXCEPT more than one test can target the **same**
  block (that's how `case 1: case 2:` fallthrough-into-shared-body is
  represented — not a separate "group" IR node, just N edges converging on
  one block), and case bodies can themselves fall through into the *next*
  case body via an ordinary fallthrough/`Jmp` edge (true switch
  fall-through, distinct from the "grouped case labels" fallthrough above).
- **`SwitchImm`/`UIntSwitchImm`/`StringSwitchImm`**: a single `switch`
  terminator (spec 03's `BlockTerminator.kind: "switch"`) with N
  `switch-case` edges (one per table slot, several may share a target) plus
  one `switch-default` edge. `defaultTarget` is a real operand — spec 03's
  warning that "`default` is not necessarily last in source and must not be
  assumed so" is confirmed directly by `53-switch-jumptable-large`, whose
  source places `default:` in the *middle* of the case list.

## 4. Matcher

Two independent matchers, both producing the same target IR (a `switch`
statement with real fall-through):
1. **Table matcher**: recognises `BlockTerminator.kind === "switch"`
   directly — no reconstruction needed beyond turning `switchTables` back
   into `case`/`default` labels using `min`/`max`/table entries. Handles all
   three opcode variants identically (operand shape is opcode-independent
   after decoding).
2. **Compare-chain matcher**: recognises a chain of blocks each ending in
   exactly one `JStrictEqual(Long)` against the **same** scrutinee register,
   tested against a fixed constant, where **multiple tests may share a jump
   target** (grouped case labels) and the final fallthrough is the
   `default` body (which may be positioned anywhere in the *source* case
   list — but is always the bytecode-final fallthrough position, since
   `default`'s bytecode position is not preserved; only its *body's*
   position relative to other case bodies is, via inter-case fallthrough
   jumps — see `53`'s test explicitly for this). Refuses to match a compare
   chain that tests **different** registers (that is not a `switch`, just
   sequential `if`s) or where the scrutinee is re-loaded/mutated between
   tests (would indicate the source used a different variable per branch).

## 5. Writer

Emits `switch (scrutinee) { case v0: ...; case v1: ...; default: ...; }`,
placing `default` at its bytecode-determined position among the case bodies
(which may not be last), and preserving real `case`-to-`case` fall-through
(no `break`) exactly where the bytecode shows a body block falling into the
next body block rather than jumping past it.

## 6. Checker

Beyond stage-A default: for the compare-chain form, asserts every case
value actually reachable in the chain is emitted (no case silently dropped
because two tests shared a target and only one was recognised); for the
table form, asserts the reconstructed `min..max` range exactly covers the
table's entry count.

## 7. Version differences

| | v84/v94 | v98/v99 |
|---|---|---|
| Dense int switch | `SwitchImm` | `UIntSwitchImm` (rename only, identical operands) |
| Dense string switch (≥ some threshold, not measured exactly) | never — always compare chain | `StringSwitchImm` |
| Sparse/small switch (any type) | `JStrictEqual`/`JStrictEqualLong` chain | same |

No fixture in the corpus currently exercises `StringSwitchImm` (see
catalogue row 8 and spec 07 §12 O-3) — the operand layout above is read from
an ad hoc probe file, not from `tests/fixtures/constructs/`, so it is marked
⛔ inferred and **a pass must not be written against it** until a fixture
exists per spec 07 §4.
