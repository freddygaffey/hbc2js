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

`32-class-basic` is the third shape: its class has field initialisers, so
hermesc seeds the allocation from a literal buffer and the emitter prints
`Object.assign(Object.create(new.target.prototype), {x: 0, y: 0, label:
"point"})`. That form is **refused** (R-CT2, section 6).

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

Delete the two allocation statements; substitute `this` for `reg`
everywhere; demote each dead store to its bare call; strip `reg`/`protoReg`
from any `let` prologue; drop a trailing `return this;`. `foldAll` is a pure
function of the statement list, which is what lets the checker re-derive it.

| Code | Refusal |
|---|---|
| R-CT0 | Not this shape at all (no stand-in, or a holder the body does not declare). Silent — no `W_PASS_REFUSED`. |
| R-CT1 | Derived class (`superClass !== null`): `this` comes from `super()`. |
| R-CT2 | Seeded allocation (`Object.assign(Object.create(...), {...})`, 32-class-basic). Foldable in principle; not measured, so not folded. |
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
