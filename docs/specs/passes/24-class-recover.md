# 24 — `class-recover` (stage B)

**Catalogue row:** 20 ([classes.md](../../lowering/classes.md)). Upgraded from
`✅ single-version` to `✅ verified` by this spec's §1.0 measurement (v98 and
v99 disassembly read and compared), which is what PL-06 requires before the
rung may register at all.
**Fixtures:** `32-class-basic`, `33-class-inheritance-super`,
`34-class-static-members`, `35-class-private-fields`,
`36-class-getters-setters`.
**Ladder row:** `00-LADDER.md` §1.x `class-recover` (batch 4).
**Versions:** **98 and 99** (layout E), not "99 only" — see §1.0 and
PUSHBACK P-22.
**Ownership:** §3 — the rung owns the *class-creation statement group* in one
function body: the statement that binds the constructor closure produced by
`CreateBaseClass`/`CreateDerivedClass`, the `Object.setPrototypeOf` pair the
emitter writes for the derived form, and every `Object.defineProperty` whose
target is that group's constructor or prototype value. It owns **no** method
body, no `new` expression, no unrelated `Object.defineProperty`, and no
`X.prototype` assignment that did not come from a class-creation opcode.

This is the largest rung in batch 4: it is the only one that *moves function
declarations* and the only one that deletes call effects. §6.4 records the
consequence — `00-LADDER.md` §4.3 lists it under "expression-only", which its
own checker cannot be.

---

## 1. Idiom evidence (measured 2026-09-05, this worktree)

Method: `node src/cli.ts disasm [--force-v98-table] <fixture>/<vNN>.hbc` and
`node src/cli.ts decompile [--force-v98-table] <fixture>/<vNN>.hbc`. Every
block quoted below is real current output of this worktree at `a61d2e0`, not
an illustration.

### 1.0 The version restriction in the ladder row is wrong

Each class fixture's `versions.txt` ends "Only v99.hbc exists in this
directory". That is stale: **all five fixtures have a committed `v98.hbc`**
(`32`, `33`, `34`, `36` also `v98.min.hbc`/`v98.obf.hbc`), built by a
`hbc98-late` pin from the Static-Hermes lineage, which does lower `class`.
Measured:

| Fixture | v98 decompiles | v98 output vs v99 output (`--passes=none`, header lines stripped) |
|---|---|---|
| 32-class-basic | yes | **identical** |
| 33-class-inheritance-super | yes (needs `resolveV98Ambiguity`) | **identical** |
| 34-class-static-members | yes (needs `resolveV98Ambiguity`) | **identical** |
| 35-class-private-fields | yes | same shape; 67 of 243 lines differ, all register allocation (`r4 = undefined` vs `r2 = undefined`) |
| 36-class-getters-setters | yes | **three lines**, all accessor function-table names: v99 `// fn#6 "get area"`, v98 `// fn#6 "area"` |

The 36 difference is the one thing F24-4 must not over-trust: **v99 prefixes an
accessor's role into the function-table name and v98 does not**, so the
descriptor (`{get: …}` / `{set: …}`) is the authority for a member's kind and
the name is only a cross-check. Everything a matcher keys on — install counts,
descriptor shape, prototype links, `new.target` reads — is equal at both
versions in all five fixtures.

and the *disassembly* of `32-class-basic` at v98 and v99 is byte-identical
below the two header lines. `33`/`34` at v98 raise `E_LAYOUT_AMBIGUOUS`
(`[hbc98-late, hbc99-mar2026]` disagree on function ids 0/1) unless the table
is forced — the ordinary v98 ambiguity the gate already resolves with
`resolveV98Ambiguity: true`, not a class-specific problem.

So catalogue row 20 now has the cross-version comparison its `✅ verified`
grade needs, and `Pass.versions` (F7) must accept **98 and 99**, layout E, not
99 alone. What is genuinely absent at ≤96 is the *compiler*, not the shape:
v84/v94/v96 `hermesc` has no class lowering in IRGen at all
(`versions.txt` per fixture, three independent minimal repros recorded there).

### 1.1 The base form — `CreateBaseClass` (sub-form **C1**)

`32-class-basic` v99, `-O` (the committed fixture), opcode counts from our
own disassembler: 1 `CreateBaseClass`, 3 `CreateClosure`, 3 `DefineOwnByVal`,
1 `GetNewTarget`. Current decompiled output, default pipeline:

```js
  // orphan: no closure creation site was found for fn#2
  function _fn2() {
    // fn#2 "distanceFromOrigin"
    "use strict";
    let r0, sqrt, r1;
    r0 = this;
    r1 = globalThis;
    sqrt = Math.sqrt(r0.x * r0.x + r0.y * r0.y);
    return sqrt;
  }
  ...
    r3 = _fn1;
    prototype = r3.prototype;
    Object.defineProperty(prototype, "distanceFromOrigin", {value: _fn2, enumerable: false, configurable: true});
    Object.defineProperty(prototype, "toString", {value: _fn3, enumerable: false, configurable: true});
    Object.defineProperty(prototype, "translate", {value: _fn4, enumerable: false, configurable: true});
```

Three facts the rung keys on, all present above:

* the constructor value is a bare closure reference (`r3 = _fn1`), emitted by
  `src/emit/lower.ts:654`'s `CreateBaseClass` case, which sets operand 0 to
  `id(closureName(fnIdx))` and operand 1 to `prop(R(op0), "prototype")`;
* every method install is `Object.defineProperty(<prototype value>, <key>,
  {value: <closure>, enumerable: false, configurable: true})` — the
  `DefineOwnByVal` lowering, `enumerable: false` being the class-method
  signature (an object literal's own methods are enumerable, §1.5);
* the method functions are emitted as **sibling declarations** (`_fn2`…),
  inside the function that creates them. Before F24-5 (landed 2026-09-05, sha
  26054f9) they carried `// orphan: no closure creation site was found` and sat
  at *module* level: `emitModule` nests a function under the owner of the
  environment it captures, and a method or constructor that captures nothing
  has none, so it looked to the emitter like a function with no site at all.
  The listing above is that older output. Since F24-5 a capture-nothing
  function whose creation sites are all in one function is declared inside that
  function (its body is scope-independent, so any host is valid and the
  declaration is hoisted above every use), which is what puts these
  declarations in `ctx.fnBody` where the rung can move them.

Target shape:

```js
class Point {
  distanceFromOrigin() { ... }
  toString() { ... }
  translate(a1, a2) { ... }
}
```

The class *name* is not in the JS output at all today; it is in the bytecode
(`// fn#1 "Point"`, i.e. the constructor function's own name in the function
table) and reaches stage B only through F24-4.

### 1.2 The derived form — `CreateDerivedClass` (sub-form **C2**)

`33-class-inheritance-super` v99: 1 `CreateBaseClass`, 2
`CreateDerivedClass`, 5 `DefineOwnByVal`, 6 `LoadParentNoTraps`, 3
`GetByIdWithReceiverLong`, 3 `CreateThisForSuper`. Current output, default
pipeline:

```js
    Dog2 = Dog;
    Object.setPrototypeOf(Dog2, r5);
    prototype2 = Dog2.prototype;
    Object.setPrototypeOf(prototype2, r5 === null ? null : r5.prototype);
    r7 = _fn5;
    Object.defineProperty(prototype2, r9, {value: r7, enumerable: false, configurable: true});
```

`src/emit/lower.ts:661` writes exactly that pair of `Object.setPrototypeOf`
calls plus the `superReg === null ? null : superReg.prototype` conditional.
The pair, in that order, with the same super value, **is** `extends`:

```js
class Dog extends Animal { speak() { ... } describe() { ... } }
```

Note the method key is a *register* (`r9`, `r8`) here, not a literal — v99
hoists the two repeated method-name strings into registers and reuses them
across all three classes. The matcher must therefore resolve a key through
the enclosing statement list, not assume a literal (refusal R-C4).

`super` itself is **not** owned by this rung (§4, R-C8). It is emitted as
`Object.getPrototypeOf(_e0_0)` + `Reflect.get(..., "speak", r1)` +
`Reflect.apply`, and as `__hbc_b_applyArguments(arguments, Object.getPrototypeOf(_e0_3), undefined, new.target)`
for the implicit derived constructor. Raising those to `super.speak()` /
`super(...)` is a separate rung (`super-form`, §6.5) with its own evidence.

### 1.3 Accessors (sub-form **C3**)

`36-class-getters-setters` v99: 5 `DefineOwnGetterSetterByVal`, 7
`CreateClosure`, 1 `CreateBaseClass`. Current output, default pipeline:

```js
    r5 = _fn5;
    r6 = r5.prototype;
    Object.defineProperty(r6, "area", {get: _fn6, enumerable: false, configurable: true});
    r3 = "width";
    Object.defineProperty(r6, r3, {get: _fn7, enumerable: false, configurable: true});
    Object.defineProperty(r6, r3, {set: _fn8, enumerable: false, configurable: true});
    r3 = new r5(4, 5);
```

Two observations that the writer depends on. (a) A get/set *pair* on one key
arrives as two separate `Object.defineProperty` calls, in get-then-set order,
so the writer must merge them into `get width()` + `set width()` members
rather than emit two class members with the same key from one descriptor.
(b) The accessor functions carry their role in their bytecode names
(`// fn#7 "get width"`, `// fn#8 "set width"`), which F24-4 exposes as a
cross-check on the descriptor.

### 1.4 Statics (sub-form **C4**) — blocked on a real emitter bug

`34-class-static-members` v99 is a class with *only* static members. Its
disassembly:

```
  0005  CreateBaseClass      r2, r2, r1, 1
  000b  LoadConstString      r5, s9 "generate"
  000f  CreateClosure        r4, r3, f2 "generate"
  0014  DefineOwnByVal       r2, r4, r5, 0
  ...
  002e  DefineOwnById        r2, r0, #c0, 6
  0034  DefineOwnById        r2, r1, #c1, 8
```

`CreateBaseClass r2, r2, ...` — **dst_ctor and dst_prototype are the same
register**, because a class with no instance members never needs the
prototype and hermesc reuses the register. `lower.ts:654` sets operand 0 to
the closure, then unconditionally sets operand 1 to `prop(R(op0),
"prototype")`, so the second `set` clobbers the first and the constructor
value is lost. Today's output installs every static onto the *prototype*:

```js
    prototype = _fn1.prototype;
    Object.defineProperty(prototype, "generate", {value: generate, enumerable: false, configurable: true});
    _e0_0 = prototype;
    prototype.nextId = 1;
```

It is self-consistent (every later read goes through the same variable, so
the fixture still PASSes), but it is wrong in general — a class that is both
instantiated and has statics would put the statics on instances — and it
makes "is this install static or instance?" undecidable from the AST. Filed
as a `docs/BUGS.md` row (2026-09-05 `class-ctor-proto-alias`); F24-3 is the
fix, and it is a **precondition** for sub-form C4.

### 1.5 What the rung must *not* touch

The same fixture 36 contains an object literal with accessors, three lines
above the class:

```js
    r1 = {_celsius: 0};
    Object.defineProperty(r1, "celsius", {get: _fn1, set: _fn2, enumerable: true, configurable: true});
```

Same helper call, same descriptor keys — but `enumerable: true` and no
class-creation opcode produced `r1`. It must survive untouched (R-C1). This
is the negative evidence that provenance (F24-2), not shape, has to drive the
match: shape alone cannot separate `Object.defineProperty` on a class
prototype from `Object.defineProperty` on any other object, which is exactly
the ES5-transpiled-class form real ≤96 bundles are full of.

### 1.6 Instance fields, and why they are not visible

`docs/lowering/classes.md` describes an
`<instance_members_initializer:Point>` function called first from the
constructor. That is the `-O0` shape. The committed fixtures are `-O`, and at
`-O` hermesc has inlined it:

```js
  function _fn1(a1, a2) {
    // fn#1 "Point"
    "use strict";
    let assign;
    assign = Object.assign(Object.create(new.target.prototype), {x: 0, y: 0, label: "point"});
    assign.x = a1;
    assign.y = a2;
    return assign;
  }
```

and for a class with no fields:

```js
    prototype = new.target.prototype;
    create = Object.create(prototype === null ? null : typeof prototype === "object" ? prototype : Object.prototype);
```

So in the shipped fixtures a constructor is an ordinary function that
allocates its own `this` from `new.target.prototype` and returns it. Turning
that into a class `constructor(a1, a2) { this.x = a1; ... }` plus field
declarations `x = 0; y = 0; label = "point";` is sub-form **C5**, and it is
the one sub-form that rewrites a *method body* (the allocation prologue
disappears, the local becomes `this`, the trailing `return <local>` becomes
implicit). §6.4 proposes deferring C5 to its own spec; C1–C4 emit
`constructor(...)` unchanged, i.e. a class whose constructor still allocates
explicitly, which is valid JS with identical behaviour only if the allocation
prologue is kept — see R-C9.

### 1.7 Private fields — refusal

`35-class-private-fields` v99 lowers `#balance` to a module-level
`Symbol("#balance")` plus `Object.defineProperty(r1, r3, {value: r0,
writable: true, enumerable: false, configurable: false})` inside the
constructor. That is not a class-body member install (it targets the
*instance*, from inside the constructor) and the key is a runtime symbol.
Refused wholesale (R-C6); the class head itself (C1) still recovers, and the
`#`-field installs stay as they are.

### 1.8 Corpus reach

`tests/fixtures/bundles/rn-template-0.72/index.android.hbc` is v94 (layout C), so it has
**zero** `CreateBaseClass`/`CreateDerivedClass` sites: this rung cannot change
that bundle's output at all. Its 11 `Object.setPrototypeOf` calls are
Babel-transpiled ES5 classes with no class opcode behind them, and are
precisely what R-C1 must refuse. Consequence for §6.1: the rn-template golden
hash does **not** change.

---

## 2. Pass placement

```
class-recover: { stage: "B", catalogue: [20],
                 after:  ["expr-rebuild", "global-access", "call-shape", "object-literal"],
                 before: ["fn-naming", "reg-split", "var-naming"],
                 versions: (v, layout) => v >= 98 && layout === "E" }
```

* **Structure-recovery block, before the renaming block.** D23: a
  structure-recovery rung runs while every register still carries its original
  bytecode identity, and this rung reads register identity twice over (it
  follows the `CreateBaseClass` destination registers through
  `Object.defineProperty` targets, and it resolves a register-held method key
  as in §1.2). `reg-split` renaming those registers per store is exactly the
  corruption D23 exists to prevent (`docs/BUGS.md`'s P-11b row, `jsx-recover`).
* **This contradicts the ladder row's `after: [call-shape, fn-naming]`** and
  `src/passes/fn-naming/index.ts`'s comment ("When either lands, the ordering
  should be enforced from its own side (`after: ["fn-naming"]`)"). Both
  predate D23. PUSHBACK **P-21**. The rung does not need `fn-naming`: every
  member name comes from the `Object.defineProperty` key, and the class name
  comes from the constructor's bytecode function name (F24-4), never from a
  recovered identifier.
* `after: ["object-literal"]` is load-bearing: the descriptor argument
  `{value: _fn2, enumerable: false, configurable: true}` is an `object` node
  only once `object-literal` has folded the stores that built it. Before that
  the matcher would see a bare register.
* `after: ["call-shape"]` keeps the ladder row's one true dependency: the
  derived form's super-constructor call and the accessor installs can arrive
  as `Reflect.apply(...)` shapes until `call-shape` has normalised them.

### Framework changes

* **F24-1** (`src/emit/ast.ts` + `src/emit/print.ts`): there is **no class
  node in the AST today** — `grep 'k: "' src/emit/ast.ts` has no `class`.
  Add
  ```ts
  { readonly k: "class"; readonly name: string | null; readonly superClass: Expr | null;
    readonly members: readonly ClassMember[] }
  ```
  as an `Expr`, plus a `{ k: "classdecl"; name: string; value: Expr }` `Stmt`
  for the declaration position, and
  ```ts
  interface ClassMember { readonly kind: "method" | "get" | "set" | "field";
                          readonly static: boolean; readonly computed: boolean;
                          readonly key: Expr; readonly value: Expr | null }
  ```
  Printer obligations: a class *expression* in statement position is
  parenthesised; a computed key prints `[k]`; a `field` with a `null` value
  prints `key;`; member order is the array order (source order matters for
  fields). `sameShape`/`effectSequence` must learn the node — a class body's
  member *values* are not evaluated at class-definition time except for
  computed keys and field initialisers, which is what makes the rewrite
  effect-neutral, and the effect model has to say so rather than assume it.
* **F24-2** (`src/emit/lower.ts` + a new `Origin` variant): provenance for the
  class-creation opcodes. The lowering must record, per site, `{ ctorFnIdx,
  ctorReg, protoReg, superReg | null, derived: boolean, offset }` and mark the
  emitted statements with it. Without it the matcher is a shape heuristic over
  `Object.defineProperty`, which §1.5 and §1.8 show is unsound (an
  ES5-transpiled class and a real class are the same shape).
* **F24-3** (`src/emit/lower.ts:654`): fix the `dst_ctor === dst_prototype`
  clobber of §1.4. When operand 0 and operand 1 name the same register, the
  emitter must materialise the constructor into its own binding first and
  install the prototype value separately, so that the two class objects are
  distinguishable. Ships with the `docs/BUGS.md` row and its own regression
  test; **C4 is refused until F24-3 lands**.
  **F24-3 landed 0f1919d** (2026-09-05): confirmed against the
  MIT-licensed Hermes VM source (`Interpreter-slowpaths.cpp`'s
  `caseCreateClass` writes the prototype value to the aliased register
  first, then the constructor value LAST -- "Write the result last in case
  it is the same register as the prototype" -- so an aliased register always
  ends up holding the constructor) that the same hazard applies to
  `CreateDerivedClass`, not only `CreateBaseClass`; both cases in
  `src/emit/lower.ts` now only write a separate prototype binding when the
  two operand registers are genuinely distinct, reading `<ctor>.prototype`
  lazily otherwise. New fixture `tests/fixtures/constructs/67-class-static-and-new`
  (both a base and a derived static-only class, each instantiated with a bare
  `new`) exercises both opcodes' aliased shape at v98 and v99; targeted unit
  test `tests/gate/emit/class-ctor-proto-alias.test.ts` asserts the
  install/read shape on fixtures 34 and 67 directly.
* **F24-4** (`src/passes/types.ts`): `PassContext.functionMeta?: (fnIdx:
  number) => { readonly name: string; readonly role: "ctor" | "nc" | "plain" }`.
  Both halves already exist and are simply not reachable from a rung: the
  name is the function-table name, and the role is
  `FunctionHeader.prohibitInvoke` (`src/parse/functions.ts:17`), which
  `src/disasm/print.ts:263` already renders as `nc`/`ctor` and which
  `docs/lowering/classes.md` §4 asked to have identified at
  HBC-FORMAT level rather than read out of disassembler text. `role === "ctor"`
  is the version-native confirmation that the `CreateBaseClass` operand really
  is a class constructor; `role === "nc"` confirms a method.
* **F24-5** (landed 2026-09-05, sha 26054f9, §6.4): the emitter's "orphan"
  hoisting. A method closure consumed by `DefineOwnByVal` used to be emitted as
  a module-level declaration with an `// orphan` comment (§1.1); it is now a
  sibling declaration inside the function that creates it. The rung *moves*
  those declarations into the class body, which is a statement move; if instead
  the emitter kept the closure inline in the descriptor, the rung would be a
  pure expression rewrite. It is the reason for §6.3, and unblocking C1/C3/C4
  is what it landed for.

---

## 3. Ownership, writer, checker

### 3.1 Site

`match(list, ctx)` returns `null` unless `list === ctx.fnBody` (F1). One site
per **class-creation group** in that body; a body may hold several (fixture
33 has three). A group is, in statement order:

1. the statement binding the F24-2-marked constructor value (`r3 = _fn1;`);
2. for the derived form only, the two `Object.setPrototypeOf` calls of §1.2,
   contiguous with (1) modulo pure statements, with the same super value;
3. the statement binding the prototype value (`prototype = r3.prototype;`),
   which F24-2 marks as operand 1 of the same site;
4. every `Object.defineProperty(<ctor value | prototype value>, k, d)` whose
   target is (1)'s or (3)'s value, until the first statement that *uses* the
   class in any other way (an instantiation, a call, a store into an
   environment slot, a return).

`Match.data` is the group: the ordered member list, the super value, the
constructor's function index, and the exact statement indices to delete.

### 3.2 Owns

The statements enumerated above, and the sibling `func` declarations named as
descriptor values by those `Object.defineProperty` calls — *only* where the
declaration's name has no other use anywhere in the module view (otherwise
the method is also referenced elsewhere and must stay a declaration; the class
member then holds a reference to it instead of the body, R-C5).

Owns nothing else: no method body (C5 excepted, deferred), no `new`
expression, no `Object.defineProperty` on a value with no class provenance, no
`X.prototype` assignment.

### 3.3 Writer

Replaces the group with one `classdecl` statement at the position of (1), with
members in the order the installs appeared, and deletes the moved `func`
declarations. Every surviving sub-expression — each method body, each computed
key, the super value — is carried over `===`-identical, never rebuilt, which
is what lets the checker compare by identity.

Getter/setter merge (§1.3): two consecutive descriptor installs on
deep-equal keys, the first accessor-only with `get`, the second accessor-only
with `set`, become two members `get k` and `set k` in that order.

### 3.4 Checker — class-shape (new; see §6.3)

`class-recover` cannot use `00-LADDER.md` §4.3's expression-only obligation:
it *deletes* call effects (every `Object.defineProperty`, both
`Object.setPrototypeOf`) and *moves* function declarations. Its obligation is:

1. **Undo.** Rebuild the deleted statement group from `after` alone — the
   class node carries every input the writer consumed — and require the result
   to deep-equal `before`. This is the strong check: any edit outside the
   declared group fails here.
2. **Effect sequence modulo the declared deletions.** `effectSequence(after)`
   must equal `effectSequence(before)` with exactly the declared
   `Object.defineProperty`/`Object.setPrototypeOf`/prototype-read effects
   removed, in order, and nothing else. The equivalence being claimed —
   "a class body performs the same own-property definitions, with the same
   descriptors, in the same order, that these calls performed" — is stated in
   `check.ts` per member kind (method/accessor: non-enumerable, writable,
   configurable, defined on the prototype; static: on the constructor;
   `extends`: both `setPrototypeOf` links) and must be re-derived from
   `Match.data`, not assumed from the node kind.
3. **Independent re-derivation.** Recompute the group from `before` by §3.1's
   rule and require the same statement index set; require `freeNames(after)`
   ⊆ `freeNames(before)`; require every moved declaration's name to be absent
   from `after`; require `parses(after)`.
4. **Constructor identity.** The class's constructor value must be the
   function index F24-2 recorded *and* `functionMeta(idx).role === "ctor"`
   (F24-4). A mismatch is a refusal, never a warning.

---

## 4. Refusals

Each is a distinct counted `abandoned` reason.

* **R-C0 `no-class-site`** — no F24-2-marked statement in the body: `match`
  returns `null` before reading anything else (PL-08 fixed point).
* **R-C1 `no-provenance`** — an `Object.defineProperty`/`Object.setPrototypeOf`
  whose target has no class provenance. This is the ES5-transpiled-class case
  (§1.8's 11 rn-template sites) and fixture 36's object literal (§1.5). The
  rung is provenance-driven precisely so that this is a refusal by
  construction, not a heuristic.
* **R-C2 `no-function-meta`** — `ctx.functionMeta` absent, or the constructor's
  role is not `"ctor"`. Never guess a class name or a role.
* **R-C3 `group-interrupted`** — a statement inside the group's span reads or
  writes the constructor/prototype value in any way other than an owned
  install, or has an effect that the class body cannot reproduce in the same
  order (any call, any throw, any member write to another object). Refuse the
  whole group; a partially recovered class is never emitted.
* **R-C4 `unresolved-key`** — a descriptor key is a register whose single
  reaching definition is not a literal, or has more than one reaching
  definition. §1.2's `r9`/`r8` are resolvable (one literal definition each);
  anything else becomes a computed member only if the key expression is pure,
  else refuse.
* **R-C5 `method-escapes`** — a descriptor's function value is referenced
  outside the group. Keep the declaration; the member holds the reference
  (`toString: <name>` cannot be written as a class member, so in this case
  refuse the *member*, which by R-C3 refuses the group).
* **R-C6 `private-members`** — any install whose key is a `Symbol("#…")`
  value, or any install inside the constructor body (§1.7). Fixture 35. This
  rung's own refusal here is unconditional and permanent (a private-name
  install is never a class-body member/accessor shape, R-C6 is not "not yet");
  the `Symbol`/computed-member shape it leaves behind is instead folded back
  into real `#name` syntax by a *separate* follow-up rung, `private-fields`
  (`after: [class-recover]`, docs/BUGS.md 2026-09-01 "class private fields",
  landed 2026-09-05) — one recognised private name at a time, refusing (and
  leaving this rung's Symbol/computed-member output untouched) whenever a
  name's reference set is not exactly `CreatePrivateName`/`AddOwnPrivateBySym`/
  `Get`/`PutOwnPrivateBySym`/`PrivateIsIn`, **and whenever the install's own
  target does not resolve to literal `this`** — every constructor this rung's
  own fixtures decompile to (32-36) builds a separate `Object.create(new
  .target.prototype)` stand-in and returns it instead of using `this`, and a
  native private field only ever attaches to the object a class's own
  `[[Construct]]` really brands, so `private-fields` refuses on all of them
  today (T2 equivalence caught the unguarded version, docs/BUGS.md's row
  reopened 2026-09-05). See docs/specs/passes/00-LADDER.md's
  `private-fields` row and `tests/gate/passes/private-fields.test.ts`.
* **R-C7 `enumerable-member`** — a descriptor with `enumerable: true` for a
  method/accessor. Class members are non-enumerable; an enumerable one did not
  come from a class body even if the target has provenance.
* **R-C8 `super-shape`** — reserved: the rung does not raise
  `Object.getPrototypeOf`/`Reflect.get`/`__hbc_b_applyArguments` to `super`
  (§1.2). Those expressions are left exactly as they are inside the moved
  method bodies, which is sound (they do not depend on being lexically inside
  a class) but leaves fixture 33's methods verbose. Counted so the gap is
  visible in the histogram.
* **R-C9 `ctor-allocates`** — the constructor body still contains the
  `new.target.prototype` allocation prologue of §1.6 **and** C5 is not
  implemented. A class `constructor` that allocates its own `this` and returns
  it is still correct (the returned object wins over the implicit one), so the
  rung *may* proceed; it refuses only when the prologue's shape is not one of
  the two §1.6 forms, because then it cannot prove the constructor is
  `new`-safe. Recorded here so the acceptance metrics count it.
* **R-C10 `statics-unfixable`** — a class-creation site whose constructor and
  prototype registers are aliased (§1.4) while F24-3 has not landed. Until
  then, C4 refuses every such site rather than guess which installs are
  static.

---

## 5. Acceptance tests

`tests/gate/passes/class-recover.test.ts`, shipped with this spec ahead of the
implementation: every test that needs the rung is `{ skip: SKIP }` and loads
it through a non-literal dynamic import, so the file typechecks and runs green
while `src/passes/class-recover/` does not exist. The orchestrator lifts the
skips in the landing commit. Rung-owned properties only — counts, shapes,
regexes, hand-built ASTs — never a whole-output comparison against a shared
fixture (CLAUDE.md testing rules, `docs/CONSOLIDATION.md` §B item 7).

Non-skipped today, and still true after the rung lands:

* **§1.0's version claim.** All five fixtures decompile at v98 and produce
  output identical to v99 apart from the header comment. This is the evidence
  behind P-22 and behind row 20's `✅ verified` upgrade, and it is a
  `--passes=none` property, so PL-05 makes it permanent.
* the baseline shapes of §1.1-§1.5, asserted at `--passes=none` (where a
  descriptor key is a register read rather than the folded literal the
  default-pipeline quotes above show): the method-install
  descriptor (`enumerable: false, configurable: true`), the derived
  `Object.setPrototypeOf` pair, the split get/set installs, fixture 36's
  *enumerable* object-literal accessors (the R-C1 negative), fixture 35's
  `Symbol("#balance")` (the R-C6 negative);
* **§1.8's corpus fact**: the committed rn-template bundle is v94 and contains no
  `CreateBaseClass`/`CreateDerivedClass`, so this rung cannot move its golden
  hash;
* **F24-1's premise**: `src/emit/ast.ts` declares no `class` node today, so the
  spec's framework item is real and not a duplicate;
* the catalogue row (20) exists and is `✅ verified` (PL-06 would otherwise
  refuse registration).

Skipped until the rung exists: registry shape and ordering (structure block,
before `fn-naming`); the `versions` predicate rejecting 84/94/96 and accepting
98/99; PL-08 fixed point on a body with no class site; fixture 32/33/36
recovering one/three/one `class` head with the right member counts and zero
surviving owned `Object.defineProperty` calls; fixture 36's object-literal
accessors surviving with the rung *on* (R-C1); fixture 35's private installs
surviving (R-C6); fixture 34's statics landing on the class object once F24-3
lands (R-C10 until then); the checker rejecting a hand-forged `after` whose
member order differs from the install order.

**Metrics to report at landing**, per fixture x version x variant
(`.min`/`.obf` included): class heads recovered, members by kind, surviving
owned `Object.defineProperty` calls, the abandoned-reason histogram, and the
`--passes=none` byte-identity check. Acceptance bar: no fixture loses its PASS
verdict; zero rewritten sites in every fixture that has no class opcode; the
rn-template output hash unchanged.

---

## 6. Needs Fred / open questions

1. **Golden hash regeneration — not needed, but confirm.** §1.8: the pinned
   rn-template output hash in `tests/gate/passes/pipeline-speed.test.ts` is a
   v94 bundle with zero class opcodes, so this rung must not move it. The
   implementer must not touch that file; if the hash *does* move, that is a
   bug in the rung, not a regeneration. (Regeneration remains Fred's call and
   is batched with the other queued goldens.)
2. **PUSHBACK P-21 — ordering.** The ladder row and `fn-naming`'s comment both
   say `after: [fn-naming]`; D23 says a structure-recovery rung runs before
   every renaming rung. §2 follows D23. Needs a ruling, and if D23 wins, the
   ladder row and `fn-naming/index.ts`'s comment should be corrected.
3. **PUSHBACK P-22 — versions.** The ladder row says "99 (≤98 later)" and each
   fixture's `versions.txt` says only `v99.hbc` exists. Both are stale: v98
   builds are committed and identical. Also needs the five `versions.txt`
   files corrected (not done here — they are fixture-build documentation and
   `tests/fixtures/build.sh` is the owner).
4. **PUSHBACK P-23 — checker class.** `00-LADDER.md` §4.3 lists `class-recover`
   under expression-only, whose obligation this rung cannot meet (it deletes
   call effects and moves declarations). §3.4 specifies a *class-shape*
   checker instead; §4.3's row should be updated when the rung lands, the way
   spec 22 §6.1 handled the same mismatch for `try-shape`.
5. **Scope split: is C5 (constructor + fields) a separate spec?** §1.6. C5 is
   the only sub-form that rewrites a method body, and the only one whose
   soundness argument involves `new.target`. Proposed: C1–C4 in this rung;
   C5 as spec 26 `class-ctor`, after F24-3 and F24-5, with its own fixtures at
   `-O0` (the shipped fixtures are `-O`, which has already inlined the
   `<instance_members_initializer>` the lowering doc describes — so a fixture
   built with `-O0` may be needed to exercise the documented shape at all).
   Recovering `super` (`super-form`) is a third rung, R-C8.
6. **F24-3 is an emitter correctness fix, not a readability one.** §1.4's
   aliasing bug is in `src/emit/lower.ts`, affects `--passes=none` output, and
   has a `docs/BUGS.md` row (2026-09-05, `class-ctor-proto-alias`).
   It should probably land as its own task with its own regression fixture
   (a class with both statics and instantiation, which no current fixture
   has), *before* this rung, rather than inside it.
7. **Does row 20's upgrade to `✅ verified` need a second reader?** The
   evidence is in §1.0 and in the acceptance test, and the confidence key's
   requirement ("read at the versions listed, including at least one
   cross-version comparison") is met — but the upgrade is what unblocks PL-06,
   so it is worth someone else confirming rather than taking on trust.

---

## 7. Landed (2026-09-05, `agent/class-recover`)

* **Sub-form C2 (the derived form) landed.** Fixture 33's `Dog` and `Puppy`
  recover at v98 and v99: both `Object.setPrototypeOf` calls and all three
  method installs are consumed, `extends` comes from the ctor-link call's
  second argument, the class name from F24-4.
* **C1, C3 and C4 refuse**, with two new counted reasons
  (`ctor-not-in-body`, `method-not-in-body`) in the R-C11/R-C12 slots. The
  cause was F24-5, not the matcher: a class method or constructor that
  captures nothing was emitted at *module* level by `emitModule`'s `parentOf`
  (it nests by captured environment, and such a closure has none), so for
  fixtures 32, 34 and 36 the declarations the class body must hold were not in
  `ctx.fnBody`. PUSHBACK **P-38**, `docs/BUGS.md` row
  `class-recover-orphan-methods`. **F24-5 landed 2026-09-05 (sha 26054f9)**:
  such a function is now declared inside the single function that creates it,
  the two refusals no longer fire on these fixtures, and the three acceptance
  tests run unskipped and green exactly as written — none was ever inverted or
  deleted. One further bug had to be fixed with it: the class-shape checker
  located the rewritten head at `rebuilt[<count of preceding deletions>]`
  instead of `rebuilt[headIndex - <that count>]`, which on 32-class-basic
  substituted the following statement's effects and counted that statement
  twice ("changed the effect sequence"). `33.obf` still refuses with
  `group-interrupted`, unchanged.
* **C5 and `super` remain out of scope**, exactly as section 6.5 proposed:
  R-C8 (`super-shape`) and R-C9 (`ctor-allocates`) stay refusals, the
  constructor is carried into the class body verbatim including its
  `new.target.prototype` allocation prologue, and fixture 35 is refused
  wholesale (R-C6). Sections 1.6/1.7 are unchanged.
* **Section 3.3's writer form changed** — a `class` *expression* substituted
  into the head statement's assignment, not a `classdecl`, because the
  constructor value is register-bound and read after the group. PUSHBACK
  **P-37**.
* **Rulings applied**: P-21 (D23 wins; the ladder row and
  `src/passes/fn-naming/index.ts`'s comment are corrected), P-22 (v >= 98,
  layout E), P-23 (`00-LADDER.md` section 4.3 gains a *class-shape* checker
  row).
* **Section 1.0 re-checked by a second reader** (this landing): all five
  fixtures decompile at v98; 32/33/34 are byte-identical to v99 below the
  header, 36 differs at exactly the three accessor-name comments, 35 only in
  register allocation. Row 20's `verified` grade stands.
