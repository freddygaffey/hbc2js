# D14: temporal dead zone enforcement is version-dependent, and the shadowing bug is a slot-aliasing artifact

**Fixture:** `20-let-const-tdz`
**Confidence:** ✅ verified — executed on real Hermes VMs at v84, v94, and
v99 (`tools/hermes-vm/v{94,99}/bin/hermes`, plus `tools/hermesc/v84/hermes`),
cross-checked against the bytecode shape at all three. **This supersedes an
earlier draft of this file that called the v84 mechanism unresolved** — a
v94/v99 VM was not available yet when that draft was written; it now is
(`tools/hermes-vm/`, built per D14's "sanctioned toolchain task"), and the
full picture is below. **This also refines `docs/specs/05-emitter.md` §8's
D14 table**, which states the shadowing fixture shows "no TDZ" at "84, 89,
94, 99" uniformly — true for the *throw*, not for the *slot-aliasing*: v99
independently fixes the aliasing half of the bug while still not enforcing
the throw. See §4.

## 1. Source

```js
function tdzDemo() {
  try { print(beforeLet); }
  catch (e) { print('caught:', e.constructor.name, e instanceof ReferenceError); }
  let beforeLet = 'now-initialized';
  print('after declaration:', beforeLet);
}

function blockTdz() {
  let val = 'outer';
  {
    try { print(val); }                          // TDZ per spec: shadowed by the inner `let val` below
    catch (e) { print('inner block TDZ caught:', e.constructor.name); }
    let val2 = 'inner-shadow';
    let val = 'shadowed';                          // shadows the OUTER `val` for this whole block
    print('inner val:', val, 'val2:', val2);
  }
  print('outer val unchanged:', val);
}
```

## 2. Executed, all three versions (`hermes <compiled from -O0>`)

| | `tdzDemo`'s `print(beforeLet)` | `blockTdz`'s `print(val)` (shadowed) | `blockTdz`'s final `print('outer val unchanged:', val)` |
|---|---|---|---|
| **v84** | throws `ReferenceError`, caught | prints `outer` (no throw) | `shadowed` |
| **v94** | prints `undefined` (no throw) | prints `outer` (no throw) | `shadowed` |
| **v99** | prints `undefined` (no throw) | prints `undefined` (no throw) | `outer` |

Full v84 output: `caught: ReferenceError true / after declaration:
now-initialized / outer / inner val: shadowed val2: inner-shadow / outer val
unchanged: shadowed`. Full v99 output: `undefined / after declaration:
now-initialized / undefined / inner val: shadowed val2: inner-shadow / outer
val unchanged: outer`. `expected.txt` (Node) has all three columns
spec-compliant (`ReferenceError`/`ReferenceError`/`outer`) and matches none
of the three Hermes versions exactly.

## 3. Bytecode — the mechanism, per version

**v84** has a real, explicit TDZ opcode pair, confirmed present in
`tdzDemo`:
```
[@ 2] LoadConstEmpty 1<Reg8>                              ; the TDZ "hole" sentinel -- NOT LoadConstUndefined
[@ 20] StoreToEnvironment 0<Reg8>, 0<UInt8>, 1<Reg8>       ; beforeLet's slot pre-initialized to the HOLE
[@ 28] LoadFromEnvironment 7<Reg8>, 0<Reg8>, 0<UInt8>      ; read it back
[@ 34] ThrowIfEmpty 8<Reg8>, 7<Reg8>                        ; hole -> throw ReferenceError; else pass through
```
`blockTdz` at v84 has **four** `ThrowIfEmpty` call sites (confirmed by
`grep`) — the check genuinely exists for the shadowing case too. It simply
never fires, because of the slot-aliasing bug below.

**v94 and v99** — `LoadConstUndefined` in place of `LoadConstEmpty`, and
**no `ThrowIfEmpty` anywhere in either function**, confirmed by `grep`
across the entire compiled module at both versions:
```
[@ 2] LoadConstUndefined 1<Reg8>                           ; NOT the hole -- ordinary undefined
[@ 18] StoreNPToEnvironment 0<Reg8>, 0<UInt8>, 1<Reg8>      ; beforeLet pre-initialized to plain undefined
[@ 28] LoadFromEnvironment 7<Reg8>, 0<Reg8>, 0<UInt8>       ; read it back -- undefined, no check, no throw
```
**Hermes silently stopped emitting the TDZ check for a plain (non-shadowed)
`let`-before-declaration reference somewhere between v84 and v94, and it
stays gone through v99.** This is a genuine version regression in ECMAScript
conformance, not an optimization difference — reproduced at both `-O0` and
default `-O`, and confirmed by direct VM execution, not just static
disassembly reading.

## 4. The shadowing bug is a slot-aliasing artifact, not a separate "no TDZ" rule

`docs/specs/05-emitter.md` §8 states Hermes shows "no TDZ" for the shadowing
fixture "measured at 84, 89, 94, 99" and that "the inner `let` writes
through to the outer binding." **That is correct for v84 and v94, but not
for v99** (§2's table, column 3: v99 alone prints `outer`, not `shadowed`).
The mechanism, read from environment-slot allocation:

- **v84 and v94**: both the outer `let val = 'outer'` and the inner,
  lexically-shadowing `let val = 'shadowed'` write to **the same**
  environment slot (slot 0 — confirmed by two `StoreToEnvironment 0<Reg8>,
  0<UInt8>, ...` instructions in the v84 dump targeting the same slot from
  different source declarations). Because they share storage, the
  shadowing `let`'s own `ThrowIfEmpty` (present at v84 — the mechanism is
  not disabled, it is simply moot) never observes the hole: by the time
  `print(val)` runs inside the block, the shared slot already holds the
  *outer* declaration's real value (`'outer'`), so `ThrowIfEmpty` passes it
  straight through. The apparent "no TDZ for shadowing" is a **side effect
  of the aliasing bug**, not an independent design choice — v84 has a live
  TDZ check right there and it still can't fire, because the slot is never
  actually empty at that point.
- **v99**: allocates the inner block's `val`/`val2` into **separate**
  environment slots (1, 2) distinct from the outer `val`'s slot (0) —
  confirmed by `CreateEnvironment` growing to 4 slots and the inner
  declarations' `StoreToEnvironment` targeting slots 1/2 while the outer
  one still targets slot 0. **v99 independently fixed the slot-aliasing
  bug** (the outer binding is no longer corrupted — `outer val unchanged:
  outer` is now correct), but it still does not throw for the shadowed
  read (no `ThrowIfEmpty` exists at v99 at all, per §3), so it prints
  `undefined` where spec/Node would throw — a *different* wrong answer
  than v84/v94's `shadowed`, but wrong in a different way.

## 5. Decompiler implication (D14)

Per `docs/specs/05-emitter.md` §8: "emit no TDZ... only emit a TDZ throw
where the bytecode has an explicit `ThrowIfEmpty`-style check" is exactly
right and is now directly confirmed at the opcode level for all three
versions read. Concretely:
- At v84: recover the `LoadConstEmpty`/`ThrowIfEmpty` pair as a real TDZ
  check and **emit `let`/`const`** (the bytecode's behaviour matches spec
  here) — *except* where slot-aliasing has merged two source-level
  bindings into one (§4), in which case emit **one** variable spanning both
  scopes (matching what the bytecode actually stores), not two lexically
  independent ones.
- At v94/v99: there is no hole/check machinery for a plain hoisted `let` at
  all — emit the variable as an ordinary pre-initialized binding (`var`-like
  storage semantics), never synthesizing a TDZ throw the bytecode doesn't
  perform.
- The slot-merge-vs-distinct-slots decision (§4) is exactly what
  `docs/specs/03-cfg.md` §3.5's environment-slot analysis already computes
  (one `EnvSlot` per distinct `(env, slot)` pair, with `readers`/`writers`
  sets) — no new analysis is needed, this file just explains *why* the
  analysis will find one slot at v84/94 and two at v99 for the same source
  shape.

## 6. Version differences (summary)

| | v84 | v94 | v99 |
|---|---|---|---|
| Hoisted `let`, TDZ check | `LoadConstEmpty` + `ThrowIfEmpty` — **enforced** | `LoadConstUndefined`, no check — **not enforced** | same as v94 — **not enforced** |
| Shadowing block, separate slot? | no — outer/inner share one slot | no — same aliasing bug as v84 | **yes** — v99 allocates a distinct slot |
| Net effect of shadowing | TDZ check present but never fires (slot never empty) | no check to fire in the first place | no check to fire, but no corruption either |
