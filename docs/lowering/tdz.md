# D14: temporal dead zone is not enforced by a runtime check

**Fixture:** `20-let-const-tdz`
**Confidence:** ✅ verified (partial — the pre-initialization mechanism is
directly read from bytecode; the *source* of the ReferenceError the fixture
does observe is not fully traced, see §4)

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
    try { print(val); }                          // should be a TDZ error (shadowing)
    catch (e) { print('inner block TDZ caught:', e.constructor.name); }
    let val2 = 'inner-shadow';
    let val = 'shadowed';                          // shadows the OUTER `val` for this whole block
    print('inner val:', val, 'val2:', val2);
  }
  print('outer val unchanged:', val);
}
```

## 2. Bytecode

`tools/hermesc/v84/hermesc -O0 -dump-bytecode -pretty-disassemble=false`,
`tdzDemo`:

```
[@ 0] CreateEnvironment 0<Reg8>
[@ 2] LoadConstUndefined 1<Reg8>
...
[@ 18] StoreNPToEnvironment 0<Reg8>, 0<UInt8>, 1<Reg8>   ; env slot 0 ('beforeLet') PRE-INITIALIZED TO undefined
                                                            ; -- BEFORE the try block even starts
[@ 22] TryGetById 6<Reg8>, 2<Reg8>, 1<UInt8>, 15<UInt16> ; print
[@ 28] LoadFromEnvironment 7<Reg8>, 0<Reg8>, 0<UInt8>    ; beforeLet -> undefined (no check, no throw here)
[@ 38] Call 8<Reg8>, 6<Reg8>, 2<UInt8>                    ; print(undefined)
[@ 42] Jmp 58<Addr8>                                      ; SUCCESS path -> skips the catch handler entirely
[@ 44] Catch 6<Reg8>                                      ; (this handler is never entered by print(beforeLet) itself)
...
[@ 100] StoreToEnvironment 0<Reg8>, 0<UInt8>, 4<Reg8>    ; let beforeLet = 'now-initialized'  -- SAME slot, later
```

Yet **executed** on the real `hermes` VM (`tools/hermesc/v84/hermes`), the
program's actual output is:
```
caught: ReferenceError true
after declaration: now-initialized
outer
inner val: shadowed val2: inner-shadow
outer val unchanged: shadowed
```
Line 1 (`caught: ReferenceError true`) shows the TDZ error **is** thrown at
runtime for `beforeLet` — which appears to contradict the bytecode reading
above (`print(beforeLet)` looks like a plain `undefined` load with no
guard). **This was not fully resolved in this research pass**: either (a)
the VM enforces TDZ via a mechanism external to the visible opcode sequence
(e.g. a hole/empty sentinel value distinct from `LoadConstUndefined`'s
`undefined` that `StoreNPToEnvironment` at `[@18]` is not actually
initializing the slot to — needs byte-level inspection of what
`StoreNPToEnvironment` with a register holding the *interpreter's* internal
"empty" value looks like, which may be indistinguishable from `undefined` in
disassembly text but is a different `HermesValue` tag at runtime), or (b)
the `-O0` dump above is not actually what ran (double check the exact binary
was recompiled from the exact same source before concluding). **Flagged as
an open item — do not assume TDZ is entirely unenforced without re-checking
this discrepancy.** What *is* solidly established, independent of that open
item, is item 2 below.

## 3. The shadowing bug — confirmed by register/slot reuse

`blockTdz`'s bytecode (`tools/hermesc/v84/hermesc -O0`) declares only **3
symbols** for the whole function (`val`, `val2`, and the `catch` binding
`e`) — there is **no separate slot for the inner block's shadowing `let
val`**:

```
[@ 42] StoreToEnvironment 0<Reg8>, 0<UInt8>, 2<Reg8>    ; let val = 'outer'   (OUTER val, env slot 0)
...
[@ 111] StoreToEnvironment 0<Reg8>, 0<UInt8>, 6<Reg8>   ; let val = 'shadowed'  -- SAME env slot 0!
```

Both the outer `let val = 'outer'` and the inner, lexically-shadowing `let
val = 'shadowed'` write to **the same environment slot**. This is directly
confirmed by the actual VM output: `outer val unchanged: shadowed` — the
"unchanged" outer `val`, read *after* the inner block has exited, comes back
as `'shadowed'`, i.e. the inner block's declaration overwrote the outer
one's storage. **Hermes's `-O0` code generator does not always allocate a
distinct environment slot for a `let` that shadows an outer `let` of the
same name within a nested block, when nothing forces the outer binding to
remain independently live.** This is a genuine implementation divergence
from spec (which requires each `let` binding to have wholly independent
storage per block, even when the names collide) and is (per D14) something
the decompiler must reproduce, not "fix."

## 4. CFG/IR shape and decompiler implication

Per `docs/specs/03-cfg.md` §3.5, environment slots are recovered by whole-
module analysis of `Load/StoreToEnvironment` — slot 0 in `blockTdz`'s
environment is written by **two lexically distinct source declarations**.
A naive recovery that assumes "one slot = one source variable" will
either (a) merge the two `let val` declarations into one variable spanning
both scopes (matching the bytecode's actual, buggy-relative-to-spec
behaviour, and therefore correct per D14), or (b) try to split them back
into two lexically-scoped variables (matching probable source intent, but
producing JS that — if run under Node — would NOT reproduce the original
program's Hermes-observed behaviour). Per D14, (a) is the required choice
unless a Hermes VM confirms otherwise for a given version.

## 5. Version differences

Only v84 was executed (via `tools/hermesc/v84/hermes`); no VM binary is
available in this project's `tools/hermesc/` for v94/v98/v99 to confirm the
slot-reuse behaviour holds identically there. The bytecode *shape* (single
environment, slot count from declared-symbol count) generalizes trivially
to later versions' explicit-env family, so the underlying mechanism (no
extra slot allocated for a same-named shadow) is expected to reproduce, but
this is **not independently executed** at v94/98/99 and should be flagged
⚠️ rather than ✅ for cross-version purposes until a VM is available (D14
notes this is a sanctioned toolchain task).
