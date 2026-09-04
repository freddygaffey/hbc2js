# Object literal with non-constant values (catalogue row 28)

Evidence for `docs/LOWERING-CATALOGUE.md` row 28 and the `object-literal`
rung (`docs/specs/passes/20-object-literal.md`). Measured with
`tools/hermesc/v94/hermesc` and `tools/hermesc/v99/hermesc`, both
`-dump-bytecode -pretty-disassemble`, on
`tests/fixtures/constructs/63-object-literal/source.js`.

## Source

```js
function point(x, y) { return { x: x + 1, y: y * 2, tag: 'p' + x }; }
function makeCounter(start) {
  let n = start;
  return { name: 'counter', inc: function () { n += 1; return n; }, read: function () { return n; } };
}
function table(a, b) { return { 1: a + 1, 0: b + 1, 10: a * b, len: a + b }; }
function selfRead(a) { const o = {}; o.a = a + 1; o.b = o.a + 1; return o; }   // NOT a literal
```

## v94 (`NewObject` + `PutNewOwn…`)

```
Function<point>:
    ...
    NewObject         r0
    PutNewOwnByIdShort r0, r3, "x"
    PutNewOwnByIdShort r0, r2, "y"
    PutNewOwnByIdShort r0, r1, "tag"
    Ret               r0

Function<makeCounter>:
    NewObject         r0
    LoadConstString   r2, "counter"
    PutNewOwnByIdShort r0, r2, "name"
    CreateClosure     r2, r1, Function<inc>
    PutNewOwnByIdShort r0, r2, "inc"
    CreateClosure     r1, r1, Function<read>
    PutNewOwnByIdShort r0, r1, "read"
    Ret               r0

Function<table>:
    NewObject         r0
    PutOwnByIndex     r0, r4, 1
    PutOwnByIndex     r0, r3, 0
    PutOwnByIndex     r0, r2, 10
    PutNewOwnByIdShort r0, r1, "len"
    Ret               r0

Function<selfRead>:                     <-- the negative control
    NewObject         r0
    ...
    PutById           r0, r1, 1, "a"    <-- PutById, NOT PutNewOwn…
    GetByIdShort      r1, r0, 1, "a"
    ...
    PutById           r0, r1, 2, "b"
```

Every value is computed **before** `NewObject`, so the store run is
contiguous.

## v99 (`NewObjectWithBuffer` + slot/index defines)

Static Hermes pre-declares the literal's *shape* (its key list, in source
order) in the object shape table and fills the non-constant values in
afterwards, by slot index:

```
Function<point>:
    NewObjectWithBuffer r1, 0, 0
    LoadConstUInt8    r0, 1
    Add               r2, r3, r0
    PutOwnBySlotIdx   r1, r2, 0
    ...
    PutOwnBySlotIdx   r1, r0, 1
    ...
    PutOwnBySlotIdx   r1, r2, 2
    Ret               r1

Function<makeCounter>:
    NewObjectWithBuffer r0, 1, 1        <-- {name: "counter", inc: null, read: null}
    CreateClosure     r2, r1, Function<inc>
    PutOwnBySlotIdx   r0, r2, 1
    CreateClosure     r1, r1, Function<read>
    PutOwnBySlotIdx   r0, r1, 2
    Ret               r0

Function<table>:
    NewObjectWithBuffer r1, 2, 5
    LoadConstUInt8    r0, 1
    Add               r4, r3, r0
    DefineOwnByIndex  r1, r4, 1
    Add               r4, r2, r0
    DefineOwnByIndex  r1, r4, 0
    Mul               r4, r3, r2
    DefineOwnByIndex  r1, r4, 10
    Add               r2, r3, r2
    DefineOwnById     r1, r2, 0, 21

Function<selfRead>:                     <-- the negative control
    NewObject         r1
    ...
    PutByIdLoose      r1, r2, 0, "a"
    GetByIdShort      r2, r1, 0, "a"
    PutByIdLoose      r1, r2, 1, "b"
```

`src/emit/literals.ts` renders the shape's keys with their (placeholder)
buffer values, so v99's definition statement is already a populated literal
— `obj = {x: null, y: null, tag: null}` — and each store *replaces* one of
those placeholders. `src/emit/shapes.ts` has already resolved a
`PutOwnBySlotIdx`'s slot index back to its key name before stage B, so the
rung never sees a slot number.

## Semantics: which store opcodes are an own-property define

From the MIT-licensed Hermes repo's `include/hermes/BCGen/HBC/BytecodeList.def`
and the interpreter cases it documents (never from hermes-dec):

| Opcode | Semantics | Equivalent to `{k: v}`? |
|---|---|---|
| `PutNewOwnById`/`…Long`/`…Short`, `DefineOwnById`/`…Long` | define an own enumerable data property, no prototype walk | **yes** |
| `PutOwnByIndex`/`…L`, `DefineOwnByIndex`/`…L` | same, integer key | **yes** |
| `PutOwnBySlotIdx`/`…Long` | store into a known own slot of the object's own shape | **yes** |
| `PutNewOwnNEById`/`…Long` | own but **non-enumerable** | no — emitter renders `Object.defineProperty` |
| `PutOwnGetterSetterByVal`, `DefineOwnGetterSetterByVal` | accessor pair | no — emitter renders `Object.defineProperty` |
| `PutById`/`PutByIdLoose`/`PutByIdStrict`/`TryPutById`, `PutByVal…` | full `[[Set]]`: walks the prototype chain | **no** |

The `PutById` row is the whole reason this rung reads the origin stamp
rather than the printed JS. `o = {}; o.a = v` and `o = {a: v}` print almost
identically but are *not* the same program: if `Object.prototype` carries an
accessor (or a non-writable data property) named `a`, the first runs the
setter (or, in strict mode, throws) and defines nothing, while the second
always creates an own data property. `selfRead` above is exactly that shape
in the bytecode, and the rung refuses it.
