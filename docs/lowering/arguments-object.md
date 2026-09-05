# `arguments` object — reification and sloppy-mode aliasing

**Fixtures:** `42-rest-params`, `49-arguments-object`, `69-arguments-reify-readback`
**Confidence:** ✅ single-version (v94, `-O0`); §8 measured at 84/94/96/98/99

## 1. Source

```js
function aliasDemo(a, b) {
  arguments[0] = 'changed-via-arguments';   // WRITE into arguments -- forces real reification
  return a;
}
function sumAll() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i];  // read-only .length / [i]
  return total;
}
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`.

**Read-only usage (`sumAll`, `arityDemo`) never materializes a real
object** — it uses two dedicated lazy accessor opcodes instead:

```
[@ 29] GetArgumentsLength 4<Reg8>, 3<Reg8>          ; arguments.length  (r3 is an internal "mapped" indicator register)
[@ 47] GetArgumentsPropByVal 5<Reg8>, 4<Reg8>, 3<Reg8>  ; arguments[i]   (idx=r4, same indicator r3)
```

**A write (`arguments[0] = ...`, `aliasDemo`) forces full reification:**

```
[@ 27] ReifyArguments 6<Reg8>       ; NOW allocate a real, mutable Arguments object into r6
[@ 29] Mov 7<Reg8>, 6<Reg8>
[@ 32] PutByVal 7<Reg8>, 5<Reg8>, 4<Reg8>   ; arguments[0] = 'changed-via-arguments'  -- ordinary PutByVal after this
[@ 36] LoadFromEnvironment 8<Reg8>, 0<Reg8>, 0<UInt8>   ; return a  -- reads the PARAMETER'S OWN storage
[@ 40] Ret 8<Reg8>
```

**Sloppy-mode aliasing, the other direction (`x = 99` then read
`arguments[0]`):**
```
[@ 15] StoreNPToEnvironment 0<Reg8>, 0<UInt8>, 3<Reg8>  ; x = 99  (writes the PARAMETER'S environment slot)
[@ 23] GetArgumentsPropByVal 6<Reg8>, 4<Reg8>, 5<Reg8>  ; arguments[0]  -- reads back 99, via the LAZY accessor
[@ 27] StrictEq 7<Reg8>, 6<Reg8>, 3<Reg8>               ; === 99  -- true, confirming aliasing
```

## 3. CFG/IR shape

`arguments`'s sloppy-mode "aliasing" behaviour (writing a named parameter
updates `arguments[i]` and vice versa) is **not** implemented by two
separate storage locations kept in sync — it works because both the
parameter and `arguments[i]` resolve to **the same underlying value**
through different access paths: the parameter is a `LoadParam`/environment
slot, and `GetArgumentsPropByVal`/`ReifyArguments`'s materialized object
read the current parameter value **live**, on every access, rather than
snapshotting it at function entry. This is why `GetArgumentsPropByVal` even
needs its `mappedIndicatorReg`-shaped third operand (name inferred from
usage, not confirmed against Hermes source) — it is presumably how the VM
knows which parameter slot(s) to re-read live vs. treat as a plain array
index beyond the declared parameter count.

Two distinct opcode families for the same source-level object:
- **Lazy/unmaterialized**: `GetArgumentsLength`, `GetArgumentsPropByVal` —
  used whenever the function only ever *reads* `.length`/`[i]` and never
  needs the object as a real value (never assigned into, never passed to
  another function, never spread, never iterated generically). Cheaper: no
  allocation.
- **Reified**: `ReifyArguments dst` — allocates a real `Arguments` object
  into `dst`; used once any usage needs a genuine object (an assignment
  into it, `Array.prototype.slice.call(arguments)`, passing it as an
  argument, spreading it, `for...in`/`for...of` over it, etc.). After
  `ReifyArguments`, all further access is via ordinary `GetByVal`/`PutByVal`
  /`GetByIdShort 'length'` — no more specialized opcodes.

## 4. Matcher

Recognises both forms as "the `arguments` object": `GetArgumentsLength`/
`GetArgumentsPropByVal` (recover as `arguments.length`/`arguments[i]`
reads, no declaration needed in the emitted JS — `arguments` is implicit),
and `ReifyArguments dst` (recover as making `dst` refer to `arguments`
itself; treat all subsequent generic array-like ops on `dst` as ordinary
property access on the `arguments` identifier, not a real array). The
matcher must **not** assume every function has an `arguments` object in the
bytecode at all — arrow functions and any function that never references
`arguments` and has no lazy/reified opcode simply have neither, per normal
JS semantics (`arguments` is not created unless used, which Hermes already
implements at the IR level by only emitting these opcodes on demand).

## 5. Writer

Emits `arguments` as the ordinary implicit identifier at every recognised
site; no `var arguments = ...` declaration is ever synthesized.

## 6. Checker

Beyond stage-A default: none additional — this idiom composes with whatever
consumes its result (ordinary property reads/array ops) rather than being a
control-flow shape of its own.

## 7. Version differences

Not cross-checked against v99 in this research pass (v94 `-O0` only). Rest
parameters (`function f(a, ...rest)`, `42-rest-params`) coexist with a live
`arguments` object in the same (sloppy) function without conflict — `rest`
is a real array built via ordinary array-literal opcodes independent of
whichever `arguments` idiom (lazy or reified) the function also uses; the
two are unrelated in the bytecode despite both deriving from "the extra
call arguments."

## 8. The last operand is the lazy-arguments register (measured, 2026-09-05)

§3 above guessed that `GetArgumentsPropByVal`'s third operand (and
`GetArgumentsLength`'s second) is a "mapped indicator" register, "name
inferred from usage, not confirmed". Measured directly against
`tools/hermesc/v84/hermes` and `tools/hermesc/v96/hermes`, it is the
function's **lazy-arguments register**:

- it holds `undefined` while the `arguments` object is still unmaterialised,
  and the lazy read then reads the frame's incoming arguments;
- `ReifyArguments*` materialises a real object **into that same register**,
  and every later lazy read goes through that object instead.

So a function that writes into `arguments` and then reads it back observes
its own write through the lazy opcodes:

```js
function k() { arguments[0] = 'K'; return arguments[0] + '|' + arguments.length; }
print(k('m0'));            // real VM, v84 and v96: K|1
```

compiles (v84) to `ReifyArguments r1` / `PutByVal r3, r0, r2` /
`GetArgumentsPropByVal r1, r0, r1` — the read names the reified register.
`src/emit` used to ignore the operand and emit the host `arguments`
unconditionally, which silently dropped the write (`docs/BUGS.md`
`arity/arguments-aliasing`); it now routes the reads of a function that
reifies through the `__hbc_argsLive` helper. Fixture
`69-arguments-reify-readback` pins this at all five committed versions.

This is *not* parameter aliasing, and §2's third block (a `x = 99` store
followed by a lazy read said to "read back 99, confirming aliasing") should
not be read as evidence of any: that block was recorded from a disassembly,
never run. Measured on the real VM, `function f(x){ x = 'mutated'; return
arguments[0] + '|' + x; }` prints `original|mutated` at v84 — the frame's
incoming argument is unchanged by the parameter store, exactly as D14 and
`src/emit/semantics.ts`'s `mappedArguments: false` say.
