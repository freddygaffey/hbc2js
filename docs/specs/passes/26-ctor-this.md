# Spec 26 — `ctor-this`: the real `this` in a recovered base-class constructor

Readability row **R12** (`docs/LOWERING-CATALOGUE.md`). Stage B.
`after: ["class-recover"]`, `before: ["private-fields", "fn-naming",
"reg-split", "var-naming"]`. Versions: 98 and 99, layout E — the same gate
`class-recover` uses, because there is no `class` node to look inside below
that.

Seven sections, per `src/passes/README.md` / spec 07 §3.2.

## 1. Source

```js
class Rectangle {
  constructor(w, h) { this._w = w; this._h = h; }
}
```

## 2. Bytecode

A Hermes class constructor allocates its own receiver rather than being handed
one. Measured on `36-class-getters-setters` fn#5 and `34-class-static-members`
fn#1, at **both** v98 and v99 (`tools/hermesc/v98|v99/hermesc
-dump-bytecode`):

```
GetNewTarget      r0
GetByIdShort      r0, r0, 1, "prototype"
NewObjectWithParent r0, r0          ; v98 reuses one register
...
Ret               r0
```

v99 emits the same three instructions but keeps the prototype in a register of
its own (`rP = new.target.prototype; rO = NewObjectWithParent rP`). Both are
the same allocation; the rung accepts either (section 5).

`NewObjectWithParent` is `Object.create` with Hermes's own null/primitive
handling, and `src/emit/lower.ts` lowers it verbatim:

```js
Object.create(p === null ? null : typeof p === "object" ? p : Object.prototype)
```

`32-class-basic` is the third shape, the **seeded** one: its class has public
field initialisers, so hermesc seeds the allocation from a literal buffer and
the emitter prints `Object.assign(Object.create(new.target.prototype), {x: 0,
y: 0, label: "point"})` -- one statement, one register, and note the bare
`new.target.prototype` rather than the null/primitive-guarded `cond` of
`NewObjectWithParent`. Refused as R-CT2 in the first landing ("foldable in
principle; not measured"); **folded since 2026-09-05**, now that it is
measured: 21 of react-navigation-example-0.85.3's 448 recovered class
constructors are this shape (9 of them with a private name in scope), against
0 of the plain shape. Fixtures 32-class-basic and 76-class-fields-private.

## 3. CFG / IR shape

Nothing CFG-level: this is a stage-B rung over the JS AST, and it only ever
looks inside the `func` expression `class-recover` installed as a class's
`constructor` member. Its site is the statement list that holds the `class`
node (`stmtLists` stops at a `func` boundary, so the constructor's body is
never a site of its own — exactly how `private-fields` reaches the same body).

## 4. Why the substitution is sound

For a **base** class, `[[Construct]]` runs
`OrdinaryCreateFromConstructor(newTarget, "%Object.prototype%")` and binds the
result to `this` *before* the constructor body runs. That is precisely
`Object.create(new.target.prototype)` — the object the bytecode allocates for
itself. So within a base constructor the stand-in register and `this` denote
the same object on every path, and:

* deleting the two allocation statements deletes a computation whose result is
  already bound to `this`;
* substituting `this` for the register is an identity substitution;
* dropping a **trailing** `return this;` is a no-op, because a base
  constructor that completes normally yields `this` anyway. An *earlier*
  `return this;` is a real early exit and is kept.

The **seeded** form is the same argument with one extra step. Its allocation
is `Object.assign(O, L)` where `O` is `Object.create(new.target.prototype)` --
the same object `[[Construct]]` bound to `this` -- so the whole statement
becomes `Object.assign(this, L);`: the same call, on the same two arguments,
in the same position. Nothing is deleted and nothing is reordered, so the
only obligation beyond the base argument is that `L` must not itself read the
stand-in register (it is evaluated *before* the assignment, so a read there
would see the pre-allocation value and substituting `this` would not be an
identity substitution) -- refused if it does. `L` must also be a plain object
literal, so that "the seed" is a thing the writer can carry across unchanged.
Note that the fold is, if anything, *closer* to the bytecode than the text it
replaces: `Object.create(p)` throws on a non-object `p`, whereas
`[[Construct]]` (and therefore the bytecode) falls back to
`%Object.prototype%`, which is what `this` denotes (D14: the bytecode is
ground truth).

A **derived** class is a different protocol entirely — `this` is TDZ until
`super()` returns it — so it is refused outright (R-CT1) rather than reasoned
about.

The end-to-end proof is the equivalence harness, not the argument above:
fixtures 32–36 and 67 are PASS under T2 (`tests/gate/decompile/
equivalence.test.ts`, v99 among the gate versions) with the rung enabled.

## 5. Matcher (`match.ts`)

For every `k:"class"` node in the statement list, with a `constructor` member
whose value is a `func`:

1. Skip leading `comment` / `directive` / `decl` statements. The next two
   statements must be stores (either the `k:"init"` or the `assign`
   spelling) of
   * `<protoReg> = new.target.prototype` (`new.target` is a `lit` node —
     `src/emit/function.ts`'s `newTargetExpr`), then
   * `<reg> = Object.create(<protoReg> === null ? null : typeof <protoReg>
     === "object" ? <protoReg> : Object.prototype)`, matched literally.
   `protoReg` and `reg` may be the same name (v98) or different (v99).
   *Or*, in the **seeded** spelling, one single store of `<reg> =
   Object.assign(Object.create(new.target.prototype), <object literal>)`;
   then `protoReg` is `reg` and the allocation is one statement, not two.
2. Both names must be **declared by this body** (`let` prologue or the `init`
   store). Not "must look like a register": `var-naming` runs on the
   constructor's own function long before `class-recover` moves its body into
   the class, so by this point the pair may already read `prototype`/`create`.
   What must hold is that the name is not an enclosing scope's variable.
3. `identUses(body, reg).writes` must be exactly the allocation's own writes
   (2 when one register does both jobs, 1 otherwise) plus the number of
   *provably dead* stores — a store whose value is a call and whose very next
   statement in the same list is an unconditional `throw`. Hermes emits one
   of those per self-brand-checking constructor (`r1 =
   __hbc_b_throwTypeError("Cannot initialize private field twice."); throw
   new Error("hbc2js: unreachable");`); the writer demotes each to a bare
   expression statement, which is what keeps the substituted body legal JS
   (`this = f()` is not).
4. When `protoReg !== reg`, the prototype temporary must be dead after the
   two statements go.
5. `reg` must not occur inside any nested closure — a register name is a
   different frame's local there (`IdentUses.nested`'s doc comment).
6. Every `return` in the constructor's own frame (`stmtLists`, so a nested
   closure's returns are not counted) must return exactly `reg`, and there
   must be at least one.

## 6. Writer (`rewrite.ts`) and refusals

Delete the two allocation statements -- or, for the seeded form, replace the
one allocation statement with `Object.assign(this, <the same literal>);` in
place; substitute `this` for `reg`
everywhere; demote each dead store to its bare call; strip `reg`/`protoReg`
from any `let` prologue; drop a trailing `return this;`. `foldAll` is a pure
function of the statement list, which is what lets the checker re-derive it.

| Code | Refusal |
|---|---|
| R-CT0 | Not this shape at all (no stand-in, or a holder the body does not declare). Silent — no `W_PASS_REFUSED`. |
| R-CT1 | Derived class (`superClass !== null`): `this` comes from `super()`. |
| R-CT2 | A seeded-looking allocation this rung will not fold: the first store's value is a call that is not `Object.assign(Object.create(new.target.prototype), <object literal>)`, or the seed literal reads the stand-in register it is about to become. The plain seeded form itself is folded since 2026-09-05 (sections 2 and 4). |
| R-CT3 | The stand-in register is written again, or the prototype temporary outlives the allocation. |
| R-CT4 | Some path returns something other than the stand-in, or nothing returns it. |
| R-CT5 | The stand-in name also occurs inside a nested closure. |

## 7. Checker (`check.ts`)

Three obligations:

1. **Independent re-derivation** — recompute `foldAll(before)` and require the
   writer's output to equal it statement for statement.
2. **The class-definition effect sequence is unchanged**, not "changed modulo
   a declared deletion" as `class-recover`'s is: everything this rung touches
   is inside a method body, and `effectSequence` deliberately does not
   evaluate one (`src/passes/ast.ts`'s `class` case — only `extends`,
   computed keys and field initialisers run at class-definition time). Any
   difference at all means the rewrite escaped the constructor.
3. `freeNames(after) ⊆ freeNames(before)` and `parses(after)`. `this` is not
   a name, so the deleted register can never come back as a capture.

## 8. Version differences

* **≤96**: no class lowering in `hermesc` at all, so the rung is gated off.
* **98**: one register for both the prototype read and the allocation.
* **99**: two registers (see section 2). Both accepted.
* The seeded form is one statement at both 98 and 99 (fixtures 32 and 76).
* Neither version changes the descriptor of the allocation itself; the
  `Object.create(... typeof ... "object" ...)` form is byte-identical at both.

## 9. Why this rung exists at all

`private-fields` (row 20) could not fold anything while a constructor
addressed a stand-in: a native `#name` brands only the object the class's own
`[[Construct]]` created, so writing `#balance` onto an `Object.create`
look-alike throws `TypeError: Cannot write private member #balance to an
object whose class did not declare it` — which T2 caught at record 0 of
fixture 35 (docs/BUGS.md 2026-09-01 "class private fields", reopened
2026-09-05). With the constructor addressing the real `this`, that rung's
`isThisArg` guard holds unchanged and fixture 35 folds `#balance`/`#history`
for real.

## 10. Measured on a real bundle (2026-09-05)

`tools/passes/ctor-this-refusals.ts` classifies every recovered class
constructor in a bundle by the code `foldCtorBody` returns, R-CT0 included
(R-CT0 is silent in the rung itself: almost every class in a real bundle is
R-CT0 and one `W_PASS_REFUSED` each would drown the diagnostics stream). On
react-navigation-example-0.85.3 (v98), 448 class constructors:

| code | classes | of those, with a `Symbol("#name")` in scope |
|---|---|---|
| R-CT1 (derived) | 304 | 130 |
| R-CT0 | 119 | 69 |
| R-CT2 (seeded) | 21 | 9 |
| R-CT3 | 4 | 4 |
| folded before this section was written | 0 | 0 |

So the dominant refusal by a factor of three is **R-CT1, the derived class**,
and it is out of reach of this rung's soundness argument: a derived
constructor's `this` is the value `super()` returns, and the decompiled text
does not contain a `super()` -- it contains `Reflect.construct(Object.
getPrototypeOf(<class binding>), [...], new.target)` plus the TDZ marker and
"super() called twice" guard Hermes emits around it. Substituting `this` for
the register that receives that call is only legal once the call itself has
been rebuilt as a real `super(...)`, which is a *different* rung (it has to
recognise the superclass expression, prove it is the class's own `extends`
binding, and prove the guard is the one the language re-creates). It is not a
250-line extension of this one, and it is not attempted here.

The seeded shape (R-CT2) is, and folds: 21 constructors across 12 module files
of that bundle. It does **not** move the round-trip numbers -- `IDENTICAL
6184 (42.83%)` and the `diff:GetOwnPrivateBySym/GetByVal` bucket at 177
functions, both unchanged before and after -- because none of the 22 classes
in the 22 modules that own a bucket function is the seeded shape (11 are
R-CT1, 9 R-CT0, 2 R-CT3). It is a readability fold on this bundle, and a
correctness prerequisite only where a seeded class also has private fields
(9 classes here; fixture 76-class-fields-private).
