# Spec 28 — `super-call`: rebuild a derived class constructor (readability row R14)

Status: **implemented 2026-09-05** (`src/passes/super-call/`); refusal **R-SC6
folded the same day** (section 9). Acceptance tests:
`tests/gate/passes/super-call.test.ts`.

## 1. Why

`ctor-this` (spec 26) folds a **base** class constructor's stand-in receiver
onto the real `this`. Its very first refusal, **R-CT1**, is the derived case:
a derived constructor's `this` does not come from an allocation of its own, it
comes from `super()`. Measured on react-navigation-example-0.85.3 (spec 26
section 10, `tools/passes/ctor-this-refusals.ts`), **304 of 448** recovered
class constructors are exactly that. Every one of them prints today as a raw
`Reflect.construct(Object.getPrototypeOf(_eD_S), [...], new.target)` with a
dead `"super() called twice"` guard after it, and every later use of the
receiver prints as a register instead of `this`. This rung is R-CT1's answer.

## 2. The shape

Measured on `tests/fixtures/constructs/33-class-inheritance-super`, v98
function #4 `"Dog"` (`class Dog extends Animal { constructor(name, breed) {
super(name); this.breed = breed; } }`), identical at v99:

```
  0000  GetNewTarget         r3
  0002  GetParentEnvironment r0, 0
  0005  LoadFromEnvironment  r0, r0, 1        ; the class's OWN binding
  0009  LoadParentNoTraps    r2, r0           ; superclass = getPrototypeOf(Dog)
  000c  CreateThisForSuper   r1, r2, r3, 0    ; the TDZ stand-in (empty)
  0011  LoadParam            r4, 1
  0014  Mov                  r5, r1           ; the call frame's `this` slot
  0017  CallWithNewTarget    r0, r2, r3, 2
  001c  SelectObject         r0, r1, r0
  0020  LoadConstEmpty       r1
  0022  ThrowIfThisInitialized r1             ; "super() called twice"
  0024  LoadParam            r1, 2
  0027  PutByIdStrict        r0, r1, "breed"
  002d  Ret                  r0
```

which `src/emit/lower.ts` prints, and which this rung therefore sees as the
exact statement pattern (`--passes=none`, v98):

```js
constructor(a1, a2) {
  let r0, r1, r2, r3, r4, r5, /* … */;
  r3 = new.target;
  r0 = undefined;
  r0 = _e0_1;
  r2 = Object.getPrototypeOf(r0);
  r4 = a1;
  r5 = r1;
  r0 = Reflect.construct(r2, [r4], r3);
  r0 = r0;
  r1 = __hbc_empty;
  if (r1 !== __hbc_empty) { throw new ReferenceError("super() called twice"); }
  r1 = a2;
  r0.breed = r1;
  return r0;
}
```

and rewrites to

```js
constructor(a1, a2) {
  let r4 = a1;
  super(r4);
  let r1_3 = a2;
  this.breed = r1_3;
}
```

## 3. Why it is sound

ES2024 13.3.7.1 (SuperCall) evaluates to exactly
`Construct(GetSuperConstructor(), argList, newTarget)` where
`GetSuperConstructor()` is `activeFunction.[[GetPrototypeOf]]()` and
`newTarget` is the running execution context's NewTarget — then binds the
result to `this` (BindThisValue) and throws a ReferenceError if `this` was
already initialised. That is instruction-for-instruction the bytecode above.
So the rewrite is an identity **provided** the three operands are the
constructor's own, which is what the matcher proves:

* `new.target` — the third `Reflect.construct` argument must dereference to the
  emitter's own `new.target` literal (`GetNewTarget`), not to any other value.
* the superclass — the callee must be `Object.getPrototypeOf(B)` where `B` is
  an **env slot that provably holds this very class**. Section 4.
* the arguments — a plain array literal with no spread element.

and that the call **dominates** every later use of the receiver: one site, at
the top level of the constructor's own frame, with no write to the stand-in
after it and no mention of it in a nested frame.

`super(...)` is emitted as a `k:"lit"` callee (the same node kind that already
carries `new.target`), so it introduces no binding: the checker's
`freeNames(after) ⊆ freeNames(before)` obligation holds trivially, and
`parses(after)` is what confirms the call landed inside a derived constructor
(a `super()` anywhere else is a SyntaxError).

### 3.1 Deleted statements

Three deletions, each justified:

1. **The `"super() called twice"` guard.** hermesc emits `LoadConstEmpty rT`
   immediately followed by `ThrowIfThisInitialized rT`: the register it tests
   is the one it has just set to `empty`, so the branch is statically dead —
   hermesc's own optimiser has already proved the single super call cannot run
   twice and left the reset behind. The rung deletes the `if` unconditionally
   (it is dead by inspection of the two adjacent statements) and the
   `rT = __hbc_empty` store only when the next statement in the same list
   overwrites `rT` without reading it, or `rT` is never mentioned again.
   The language re-creates this guard from `super(...)`: one super call
   dominating the body is exactly the case in which BindThisValue can never
   see an initialised `this`.
2. **The operand stores** (`rN = new.target`, `rN = <slot>`,
   `rM = Object.getPrototypeOf(rN)`, `Mov rS, rThis`, the `SelectObject`
   move). Deleted one at a time, in reverse, only when the value provably
   cannot run user code (an identifier, a literal, `this`, a non-computed
   member on one of those — or the one `Object.getPrototypeOf` call this site
   itself consumed, whose argument is a class and therefore never a Proxy with
   a `getPrototypeOf` trap) **and** the target has no surviving read in the
   head, in the super arguments or in the tail, and is not mentioned in a
   nested closure.
3. **A trailing `return this;`.** A derived constructor that falls off its end
   yields its `this` binding, and the `super(...)` above dominates the end, so
   the explicit return is noise. Only the *tail* return goes; an earlier one is
   a real early exit and is kept (as `return this;`).

## 4. R-SC1: proving the superclass is this class's own binding

The constructor reads its class from an env slot of an **enclosing** frame
(`_e0_1` above), so the proof cannot be local to the constructor. It is
available in the rung's own input: `super-call` is a stage-B rung that runs on
the *enclosing* function's statement list, which `class-recover` has already
rewritten, and which therefore contains both the class expression and the store
that publishes it:

```js
r6 = class Dog extends r5 { … };
r3 = r6.prototype;
_e0_1 = r6;
```

`classBindingSlots(module, cls)` accepts `_eD_S` when

* some statement list of the module body stores the **identical** class node
  into a holder `X` (node identity, not a structural match), and
* a later statement in the **same list** is `_eD_S = X`, with nothing between
  the two that overwrites `X` or that can run user code (only identifiers,
  literals, `this` and non-computed member reads on those are allowed — a
  `.prototype` read, which is what hermesc puts there), and
* `_eD_S` is written **exactly once** anywhere in the module body, nested
  frames included, so the slot can never come to hold anything else.

Anything else is R-SC1. In particular a bare register name is never accepted:
a Hermes register never crosses a frame boundary, so a constructor reading one
free is not reading its own class.

## 5. Ordering

`after: ["class-recover"]`, `before: ["ctor-this", "private-fields",
"fn-naming", "reg-split", "var-naming"]`.

* **After `class-recover`** — the rung needs the `class` node (to know it is
  looking at a derived class's constructor, and to have the constructor body in
  hand) and the enclosing body's `_eD_S = <class>` store.
* **Before `ctor-this`** — and `ctor-this` needs no change at all. Its R-CT1
  refusal keys on `cls.superClass !== null`, which is still true after this
  rung runs, and a derived constructor never contains the
  `new.target.prototype` + `Object.create(...)` allocation `ctor-this` folds,
  so there is no site here for it either before or after. Extending `ctor-this`
  to "accept the rebuilt derived shape" would be busywork: the rebuilt shape
  already *is* `this`. Keeping the two rungs disjoint also keeps each
  checker's independent re-derivation exact.
* **Before every renaming rung** (P-21 / D23) — the matcher follows register
  identity, which `reg-split`'s per-store renaming would corrupt.

Versions: `hbcVersion >= 98 && layoutClass === "E"`, the same gate
`class-recover` and `ctor-this` use.

## 6. Refusals

| code | refused when | note |
| --- | --- | --- |
| R-SC0 | base class, or no `Reflect.construct` site in the constructor | silent (not reported as a refusal): this is simply "not my shape" |
| R-SC1 | the superclass expression, or `new.target`, is not provably the constructor's own — the callee is not `Object.getPrototypeOf(B)`, `B` is not a single resolvable binding, or `B` is not an env slot that section 4 proves holds this class | the one refusal that protects correctness rather than shape |
| R-SC2 | more than one `Reflect.construct` site in the constructor (a conditional super) | no single call dominates the body |
| R-SC3 | the single site is not a top-level store of the constructor's own frame — it is inside a loop, a `try`, an `if` or a closure | |
| R-SC4 | the stand-in register is written again after the super call | the rung cannot then say the register *is* `this` |
| R-SC5 | the stand-in register name also occurs inside a nested closure, where the same register number is a different frame's local | same reason as `ctor-this`'s R-CT5 |
| R-SC6 | *(retired 2026-09-05 -- the implicit/forwarding derived constructor is now folded; section 9)* | was: `return __hbc_b_applyArguments(...)`. The code is not reused for anything else, so an old report's R-SC6 still reads as this shape |
| R-SC7 | the super arguments are not a plain array literal, or contain a spread element | `docs/BUGS.md`. Fixture 78's `Explicit` is this shape at v98/v99 (hermesc reaches it through `copyRestArgs` + `arraySpread` + `applyWithNewTarget`, so today it lands in R-SC0 -- no `Reflect.construct` site at all -- rather than in R-SC7 itself) |
| R-SC8 | in the section 9 forward, an operand is not provably the constructor's own: the target is not `Object.getPrototypeOf(B)` with `B` this class's own binding, the `new.target` argument is not the frame's own `new.target` literal, the forwarded list is not the frame's own `arguments`, or a receiver is passed (the helper's *apply* path, not the construct path) | R-SC1's twin, for the forward |
| R-SC9 | the forward is not the constructor's whole body: another statement, another `arguments` read (in the constructor or a nested arrow), a declared parameter, a returned expression that is not the forward, or a directive other than `"use strict"` | shape, not correctness |

Reads of the stand-in register *before* the super call are not refused and not
rewritten: the register is reused by the operand sequence itself
(`r0 = _e0_1` above), and the construct overwrites it, so no later read can
observe the earlier value.

## 7. Checker

The same three obligations `ctor-this` carries, for the same reason —
everything this rung touches lives inside a constructor body, which
`effectSequence` deliberately does not evaluate:

1. **Independent re-derivation.** `foldAll(before)` is recomputed and compared
   to the writer's output statement for statement.
2. **An unchanged class-definition effect sequence.** Not "modulo a declared
   deletion" as `class-recover`'s is: any difference at all means the rewrite
   escaped the constructor body.
3. **No new free name, and `parses(after)`** — the latter is also what proves
   the emitted `super(...)` is legal where it landed.

## 8. Measurement

`tools/passes/ctor-this-refusals.ts` reports R-SC codes alongside the R-CT
ones (`--codes`), so the same command re-measures both rungs on a bundle.
Numbers at landing are in `docs/AGENT-LOG.md` and in the landing report.

## 9. R-SC6 folded: the implicit derived constructor

Measured on fixture 78 (`tests/fixtures/constructs/78-class-implicit-derived-ctor`)
at v98 and v99, and on fixture 33's `class Puppy extends Dog {}`, a derived
class with **no constructor of its own** gets one whose entire body is

```js
constructor() {
  // fn#3 "Implicit"
  "use strict";
  return __hbc_b_applyArguments(arguments, Object.getPrototypeOf(_e0_0), undefined, new.target);
}
```

`__hbc_b_applyArguments` (`src/runtime/helpers.ts`, spelled from
`src/emit/builtins.ts`'s own intrinsic table -- a forward spelled any other
way is not this emitter's output and is never claimed) is

```js
if (newTarget !== undefined) return Reflect.construct(fn, Array.prototype.slice.call(callerArgs), newTarget);
return Reflect.apply(fn, thisArg, callerArgs);
```

and a class constructor can only ever be reached with a NewTarget (ES2024
10.2.1 step 2 throws before the body runs otherwise), so the construct branch
is the only reachable one. That branch is
`Construct(GetSuperConstructor(), <the caller's whole argument list>, newTarget)`
followed by returning the result -- which is ECMAScript 15.7.14 step 14's
default derived constructor, `constructor(...args) { super(...args); }`,
statement for statement. The rewrite is therefore an identity given what
`foldForwardBody` proves: R-SC8's four operand obligations and R-SC9's shape
obligations (the forward is the constructor's whole body, `arguments` is read
nowhere else, and the constructor declares no parameters of its own).

### 9.1 Why the explicit form and not an elided constructor

The recovered text is `constructor(...args) { super(...args); }`, never "no
constructor at all", even though the source almost certainly had none:

* **Provenance.** The emitted constructor carries the `// fn#N "<name>"`
  comment that maps it to a real Hermes function. Deleting the member would
  delete the only anchor between function #N and the output, which every
  per-function tool (`tools/passes/*`, the round-trip corpus, the name
  overlay) keys on. Keeping one emitted function per bytecode function is a
  pipeline-wide invariant; a readability rung is the wrong place to break it.
* **It costs one line.** The elided form is shorter but says the same thing,
  and the explicit form is legal source an author could have written.
* **It is not needed to disambiguate.** hermesc does *not* lower the explicit
  `constructor(...a) { super(...a); }` to this shape -- fixture 78 pins that
  it lowers to `copyRestArgs` + an array spread + `applyWithNewTarget`
  instead. So the forward really does mean "the source had no constructor",
  and a future rung may elide it; that is a separate, purely cosmetic step
  which must first answer the provenance question above. Recorded here rather
  than done, deliberately.

### 9.2 The `"use strict"` directive is dropped

The rebuilt constructor has a **non-simple parameter list**, and ES2024 15.2.1
(Early Errors for FunctionBody) makes a "use strict" directive prologue a
SyntaxError there. The directive is deleted, which is a no-op: a class body is
always strict code (ES2024 15.7). Any *other* directive is refused (R-SC9)
rather than dropped. This was caught by the checker's own `parses(after)`
obligation, which is exactly what it is for.

### 9.3 The parameter list

This is the ladder's first stage-B rung to change a function's parameter list,
and **no framework helper was missing**: `Param` (`src/emit/ast.ts`) already
carries `rest?: true`, `mapStmts`/`mapParams` already carry a params list
through unchanged, and `spread-rest`'s writer (`src/passes/spread-rest/rewrite.ts`)
already rebuilds one as `{ ...fn, params: [...] }`. The class member is
rebuilt the same way, in `foldAll`: `{ ...ctor, params, body }`. The rest
parameter is named `args`; it can shadow nothing that is read, because the
body it lands in contains no other name.

### 9.4 What the constructor may also contain

The forward must be the constructor's **last** statement; before it the rung
accepts only what the emitter puts there and what it can account for: the
`// fn#N` provenance comment (kept), the `"use strict"` directive (dropped,
9.2), a hoisted `function` declaration this frame merely hosts (kept -- a
declaration runs no user code and is legal before `super()`), a register `let`
(kept only while something still reads it), and the operand moves the forward
itself consumed. Those moves are how the operands actually reach the call
(`r5 = r2; r3 = r1; applyArguments(arguments, r5, r4, r3)`), so the matcher
chases each operand with `derefChain`: up to four hops, each resolved against
the stores preceding the hop it came from and never a later one, so a register
reused after its move is never followed. The moves are then deleted in
reverse, and only when nothing that survives -- a later head statement, a
nested closure -- still reads the target; a store that cannot be deleted is
R-SC9 rather than left behind. The rest parameter is renamed (`args2`, ...)
if any surviving statement would be shadowed by `args`.

### 9.5 Residue on react-navigation-example-0.85.3

`node tools/passes/ctor-this-refusals.ts` before -> after: FOLD 39 -> 52,
R-SC6 168 -> 0, and a new R-SC9 147 -- so 13 of the 168 folded and 147 became
a *narrower* refusal. 136 of those 147 have the shape `R-SC9 func`: a
forwarding constructor whose frame also hosts a hoisted `function`
declaration. Section 9.4 accepts the declaration itself, so what still refuses
them is `argumentsUses(body) !== 1`: the check counts an `arguments` mention
anywhere in the constructor, **nested frames included**, and a hosted
declaration that uses its own `arguments` therefore reads as a second use of
the constructor's. That is deliberately conservative (over-refusing is safe),
and it is the next step: a non-arrow nested `func` has its own `arguments`
object, so the count should skip nested frames unless `sameFrame === true`
(the generator-resume closure, `src/emit/ast.ts`) -- the same distinction
`countUses` already makes. Not done here: it changes what the rung claims on
136 real constructors and deserves its own measurement.

**Done (agent/super-forward-2)**: `argumentsUses` is now frame-aware, mirroring
`countUses`'s `func`/`sameFrame` distinction (`src/passes/super-call/match.ts`).
A bare `argumentsObject` read counts only in this frame or a `sameFrame`
closure; an `ident{name:"arguments"}` read counts everywhere however deep,
because that shape is never a non-arrow nested `function`'s own (which always
reifies its own `argumentsObject`, a separate frame) -- it is only how a
nested arrow surfaces a lexical read of an enclosing frame's `arguments`
(`arguments-form/match.ts`'s own recognition of the two shapes as
equivalent). Three unit tests pin the three cases (`tests/gate/passes/
super-call.test.ts`): a hosted function's own `arguments` no longer counts
and the constructor folds; a nested arrow's `arguments` (the `ident` shape)
still counts and refuses; a `sameFrame` closure's `arguments` (the
`argumentsObject` shape, still this frame) still counts and refuses.

**Measured, and it does not move react-navigation-example-0.85.3**:
`node tools/passes/ctor-this-refusals.ts` before -> after is unchanged, FOLD
52, R-SC9 147 (`R-SC9 func` 136 of them). Dumping the actual refused bodies
(a spied `foldSuperBody`, not committed) shows why: none of the 136 are
blocked by `argumentsUses` at all -- they fail the *earlier* "the
applyArguments forward is not the constructor's last statement" check,
because their last statement is `return r0;` with `r0 = __hbc_b_applyArguments(
...)` assigned on the *previous* statement, not `return
__hbc_b_applyArguments(...)` directly. `foldForwardBody` (section 9.4) only
ever matches the latter -- there is no dereference of a `return <ident>`
back through a preceding store, unlike the operand moves *into* the call,
which `derefChain` already chases. So section 9.5's original diagnosis was
half right (the hosted declaration's own `arguments` is real conservatism,
now fixed and independently correct/tested) but named the wrong blocker for
this bundle's 136: the store-then-return split gates them first, and
`argumentsUses` is never reached. This is a materially different, larger
change (deref through a `return`, with the same conservatism `derefChain`
already has about a register reused after its move) and is not done here --
tracked as its own residue in `docs/BUGS.md`'s `diff:GetOwnPrivateBySym/
GetByVal` row (tail), since the corpus payoff cannot be checked until it
lands. `node tools/e2e/roundtrip-corpus.ts --only react-navigation-example-
0.85.3 --passes on` before -> after: IDENTICAL count and the `diff:
GetOwnPrivateBySym/GetByVal` bucket unchanged, exactly as expected from a
fix whose own real-bundle payoff is still gated by the residue above.
