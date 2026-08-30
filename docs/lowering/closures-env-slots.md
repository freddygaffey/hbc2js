# Closures and environment slots, including **D14: `for (let)` has no per-iteration binding**

**Fixtures:** `17-closure-loop-var`, `18-closure-loop-let`,
`21-iife-closures`, `22-nested-closures-counters`
**Confidence:** ✅ verified (v84 execution; v94/v99 bytecode shape) for the
D14 finding — the single most important surprise from this research pass.

## 1. Source

```js
// 17-closure-loop-var.js
const closures = [];
for (var i = 0; i < 3; i++) {
  closures.push(function () { return i; });
}
// prints: var closures all see final i: 3,3,3     (expected — `var` bug)

// 18-closure-loop-let.js
const closures = [];
for (let i = 0; i < 3; i++) {
  closures.push(function () { return i; });
}
// per spec / Node: let closures each see own i: 0,1,2
```

## 2. Bytecode

`tools/hermesc/v84/hermesc -O0 -dump-bytecode -pretty-disassemble=false`,
**`18` (the `let` version)**:

```
[@ 0] CreateEnvironment 0<Reg8>                    ; ONE environment for the WHOLE function — created ONCE
[@ 2] LoadConstUndefined 1<Reg8>
...
[@ 57] StoreNPToEnvironment 0<Reg8>, 1<UInt8>, 2<Reg8>   ; i = 0            (loop init)
L:
[@ 61] LoadFromEnvironment 11<Reg8>, 0<Reg8>, 1<UInt8>   ; i
[@ 65] Less 12<Reg8>, 11<Reg8>, 6<Reg8>
[@ 69] JmpFalse 55<Addr8>, 12<Reg8>                      ; i < 3
[@ 72] LoadFromEnvironment 11<Reg8>, 0<Reg8>, 0<UInt8>   ; closures
[@ 76] GetByIdShort 12<Reg8>, 11<Reg8>, 1<UInt8>, 10<UInt8>
[@ 81] CreateClosure 13<Reg8>, 0<Reg8>, 1<UInt16>        ; function(){return i} — CAPTURES THE SAME env every time
[@ 92] Call 14<Reg8>, 12<Reg8>, 2<UInt8>                 ; closures.push(that closure)
[@ 99] LoadFromEnvironment 11<Reg8>, 0<Reg8>, 1<UInt8>   ; i
[@ 103] ToNumeric/Inc/StoreToEnvironment 0,1,...         ; i++     -- WRITES BACK INTO THE SAME SLOT
[@ 113] Less/JmpTrue ... -> L
```

**`17` (the `var` version) is structurally identical** — same single
`CreateEnvironment`, same `StoreToEnvironment 0,1,...` slot reused every
iteration for the loop variable (the only difference is `var i` at top level
would go through `DeclareGlobalVar`/`PutById` instead of an environment
slot, but inside a function body both `var` and `let` loop variables end up
as ordinary environment slots with **no per-iteration copy** in either
case).

**Executed with `tools/hermesc/v84/hermes` (D14: ground truth is the VM, not
Node):**

```
$ ./tools/hermesc/v84/hermes /tmp/t18.hbc
let closures each see own i: 3,3,3
nested let closures: 3:2 | 3:2 | 3:2 | 3:2 | 3:2 | 3:2
```
vs. `expected.txt` (Node, spec-compliant): `0,1,2` and
`0:0 | 0:1 | 1:0 | 1:1 | 2:0 | 2:1`.

**`for (let i ...)` behaves EXACTLY like `for (var i ...)` under Hermes.**
This is not a TDZ nuance or an edge case — it is the single most common
"closures in a loop" idiom in real-world JS, and Hermes gets it wrong
relative to spec/Node/every other major engine, at v84 (executed) and,
per identical bytecode shape, at v94 and v99 as well (`grep`-verified: `18`'s
v94 and v99 `-O0` dumps both show exactly one `CreateEnvironment`/
`CreateTopLevelEnvironment` for the whole function, with the same
single-slot reuse across iterations — no `CreateInnerEnvironment`-per-
iteration pattern of the kind a spec-compliant per-iteration `let` would
need).

## 3. CFG/IR shape

One `CreateEnvironment` (or, v≥97, `CreateFunctionEnvironment`/
`CreateTopLevelEnvironment`) per **function**, not per loop iteration, not
per block. All `let`/`const`/`var` bindings declared anywhere in that
function (including inside nested blocks and loop headers) are flattened
into slots of this **one** environment record, indexed by a compile-time-
assigned slot number (`docs/specs/03-cfg.md` §3.5's `EnvSlot`). A closure
created inside a loop body (`CreateClosure dst, env, fnIdx`) always
references the **same** `env` register/environment object on every
iteration — there is no mechanism in the bytecode that would let two
iterations' closures see different values for the same source-level `let`
variable, because there is only ever one storage location for it.

## 4. Matcher / decompiler implication

**This is not a "pass" in the readability sense — it changes what the
*correct* decompiled output must be.** Per D14 (ground truth is the Hermes
VM, not Node/spec), the decompiler must emit code whose behaviour matches
the bytecode's actual aliasing, not "what the source probably said." Two
options, both discussed in `docs/DECISIONS.md` D14 but neither yet resolved
in a spec:
1. Emit `var i` instead of recovering `let i` for any loop variable that a
   closure captures **and** that is written on every iteration into the
   same slot all captured closures reference — i.e. deliberately
   **under-recover** `let`→`var` when doing otherwise would silently change
   the equivalence-checker's (D2/D15) observed behaviour.
2. Emit `let i` faithfully but accept that the decompiled JS, if re-run
   under **Node** (rather than the Hermes VM the bytecode came from), will
   diverge from the original Hermes execution trace — which D15's oracle
   ladder would then have to catch as DIVERGENT, not silently accept.

Recommend (1): decompiled output should be checked against the Hermes VM
trace (D14/D15), and a `let`-in-loop that the bytecode proves has no
per-iteration binding should not be re-sugared into a `let` that *would*
create one under a spec-compliant reader (including a human reading the
decompiled output and assuming it behaves like normal JS). This has direct
consequences for spec 05 (emitter) and spec 07 (any future pass touching
loop variable declarations) — **flagging for those specs' owners.**

## 5. Nested loops (`18`'s second case)

```js
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 2; j++) {
    closures2.push(function () { return i + ':' + j; });
  }
}
// expected (spec): 0:0 | 0:1 | 1:0 | 1:1 | 2:0 | 2:1
// actual (v84 hermes): 3:2 | 3:2 | 3:2 | 3:2 | 3:2 | 3:2   (both i AND j collapse to their final values)
```
Confirms the same single-environment-slot-reuse mechanism applies uniformly
regardless of nesting depth — there is exactly one `CreateEnvironment` for
the whole function no matter how many nested `let`-headed loops it contains.

## 6. Version differences

None in the "no per-iteration environment" finding — v84 (executed), v94
and v99 (bytecode shape only, no VM binary available for those versions in
`tools/hermesc/`) all show the identical single-`CreateEnvironment`-per-
function shape. This should be treated as **verified for v84** and
**single-version-equivalent-shape for v94/v99** — if a future Hermes VM
build for those versions becomes available (`docs/DECISIONS.md` D14
mentions this as a sanctioned toolchain task), re-running this exact
executable check is high priority.
