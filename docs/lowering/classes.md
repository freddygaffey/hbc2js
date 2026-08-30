# Classes (v99 only) — `CreateBaseClass`/`CreateDerivedClass`, `Constructor<N>`, `NCFunction<N>`

**Fixtures:** `32-class-basic`, `33-class-inheritance-super`,
`34-class-static-members`, `36-class-getters-setters`
**Confidence:** ✅ single-version (v99 only — per every fixture's
`versions.txt`, plain `class` syntax fails to compile at all on v84/v94;
instance/static field syntax additionally requires v99 specifically among
this project's four fetched versions, so there is no cross-version
comparison to make for this idiom)

**Read at `-O0`** — default `-O` aggressively cross-function-inlines trivial
single-call-site constructors (confirmed: `32-class-basic` at default `-O`
has **no separate constructor function at all**, the `new Point(3,4)`
instance-field-initialization sequence is inlined directly into `global`).
`-O0` is required to see the actual per-function class-lowering shape.

## 1. Source

```js
class Point {
  x = 0; y = 0; label = 'point';
  constructor(x, y) { this.x = x; this.y = y; }
  distanceFromOrigin() { return Math.sqrt(this.x*this.x + this.y*this.y); }
  toString() { return this.label + '(' + this.x + ',' + this.y + ')'; }
}
```

## 2. Bytecode

`tools/hermesc/v99/hermesc -O0 -dump-bytecode -pretty-disassemble=false`.
Function table for this one `class` declaration:

```
Function<global>                                     ; module top level
Function<<instance_members_initializer:Point>>        ; runs x=0;y=0;label='point'
Constructor<Point>                                    ; the user-written constructor(x,y){...}
NCFunction<distanceFromOrigin>
NCFunction<toString>
NCFunction<translate>
```

**The disassembler itself distinguishes three function roles** —
`Function<>` (ordinary closures, and this field initializer), `NCFunction<>`
("Non-Constructible" — every plain class method; cannot be called with
`new`), and `Constructor<>` (the class's own constructor) — which maps
directly onto `docs/specs/03-cfg.md` §2's `classifyFunctions`. This is a
free, version-native signal for function classification that spec 03
doesn't yet mention using.

**Class declaration** (`global`):
```
[@ 35] CreateClosure 2<Reg8>, 3<Reg8>, 1<UInt16>         ; the <instance_members_initializer:Point> function
[@ 40] StoreToEnvironment 3<Reg8>, 6<UInt8>, 2<Reg8>     ; stashed in an env slot for the constructor to call later
[@ 44] CreateBaseClass 4<Reg8>, 2<Reg8>, 3<Reg8>, 2<UInt16>  ; dst_ctor=r4, dst_prototype=r2, env=r3, ctorFnIdx=2
[@ 50] CreateClosure 6<Reg8>, 3<Reg8>, 3<UInt16>         ; distanceFromOrigin
[@ 55] LoadConstString 5<Reg8>, 'distanceFromOrigin'
[@ 59] DefineOwnByVal 2<Reg8>, 6<Reg8>, 5<Reg8>, 0<UInt8>  ; installed on the PROTOTYPE (r2), non-enumerable (flag 0)
[@ 64] CreateClosure 6<Reg8>, 3<Reg8>, 4<UInt16>         ; toString  (same DefineOwnByVal pattern)
[@ 78] CreateClosure 6<Reg8>, 3<Reg8>, 5<UInt16>         ; translate
...
```

**Instantiation** (`new Point(3, 4)`):
```
[@ 108] LoadFromEnvironment 4<Reg8>, 3<Reg8>, 0<UInt8>   ; the `Point` binding
[@ 112] CreateThisForNew 2<Reg8>, 4<Reg8>, 0<UInt8>       ; allocate `this` from Point.prototype (a `CreateThis`
                                                             variant specific to class/new-target semantics)
[@ 131] Construct 4<Reg8>, 4<Reg8>, 3<UInt8>              ; call the constructor with (this, 3, 4)
[@ 135] SelectObject 2<Reg8>, 2<Reg8>, 4<Reg8>            ; keep `this` unless the ctor explicitly returned an object
```

**`Constructor<Point>` body:**
```
[@ 0] GetParentEnvironment 2<Reg8>, 0<UInt8>
[@ 3] CreateEnvironment 1<Reg8>, 2<Reg8>, 3<UInt32>
[@ 10] GetNewTarget 3<Reg8>
[@ 12] GetByIdShort 3<Reg8>, 3<Reg8>, 0<UInt8>, 'prototype'   ; new.target.prototype -- NOT the closure's own
                                                                 captured class, so Reflect.construct-style
                                                                 subclassing resolves the right prototype
[@ 17] NewObjectWithParent 3<Reg8>, 3<Reg8>                    ; this = Object.create(new.target.prototype)
[@ 24] LoadFromEnvironment 2<Reg8>, 2<Reg8>, 6<UInt8>          ; the <instance_members_initializer:Point> closure
[@ 28] LoadFromEnvironment 3<Reg8>, 1<Reg8>, 2<UInt8>          ; `this`
[@ 32] Call1 0<Reg8>, 2<Reg8>, 3<Reg8>                          ; RUN THE FIELD INITIALIZER, before any user code
[@ 36] LoadParam 2<Reg8>, 1<UInt8>                              ; x
[@ 39] StoreToEnvironment 1<Reg8>, 1<UInt8>, 2<Reg8>
[@ 43] LoadParam 2<Reg8>, 2<UInt8>                              ; y
...
[@ 58] PutByIdStrict 2<Reg8>, 3<Reg8>, 0<UInt8>, 'x'            ; this.x = x   (user's own constructor body)
[@ 72] PutByIdStrict 3<Reg8>, 2<Reg8>, 1<UInt8>, 'y'            ; this.y = y
[@ 78] LoadFromEnvironment 1<Reg8>, 1<Reg8>, 2<UInt8>           ; return this  (implicit)
[@ 82] Ret 1<Reg8>
```

**`extends`** (`33-class-inheritance-super`): `CreateBaseClass` becomes
`CreateDerivedClass dst_ctor, dst_prototype, env, superClassReg,
ctorFnIdx` — one extra operand naming the superclass constructor. `super.
method()` compiles to:
```
[@ 13] LoadFromEnvironment 1<Reg8>, 1<Reg8>, 10<UInt8>   ; the home object (Dog.prototype), captured in an env slot
[@ 17] LoadParentNoTraps 1<Reg8>, 1<Reg8>                 ; [[HomeObject]].[[GetPrototypeOf]]() = Animal.prototype
[@ 20] GetByIdWithReceiverLong 1<Reg8>, 1<Reg8>, 0<UInt8>, 2<Reg8>, ...  ; lookup on Animal.prototype,
                                                                            but RECEIVER = this (r2) --
                                                                            preserves `this` binding through super
[@ 29] Call1 1<Reg8>, 1<Reg8>, 2<Reg8>
```

## 3. CFG/IR shape

A `class` declaration is: one `CreateBaseClass`/`CreateDerivedClass`
allocating the constructor closure + its `.prototype` object together, N
`CreateClosure`+`DefineOwnByVal` pairs installing methods onto the
prototype (non-enumerable, per the `0<UInt8>` flag operand — confirmed
consistent across every method in every class fixture read), and — only
when instance fields are present — one extra `CreateClosure` for a
synthetic `<instance_members_initializer:ClassName>` function, called
**unconditionally, first**, from inside every constructor path (both the
user-written `Constructor<N>` and, by extension, any implicit default
constructor a subclass without its own `constructor(){}` would get —
not directly observed in these fixtures, flag as unconfirmed).
Instantiation is ordinary `CreateThisForNew`/`Construct`/`SelectObject`,
distinguished from a plain function's `new` only by `CreateThisForNew`
consulting `new.target.prototype` rather than the callee's own `.prototype`
(relevant for `extends`/`Reflect.construct`).

## 4. Matcher

Recognises: `CreateBaseClass`/`CreateDerivedClass` at a definition site as
the head of a `class` declaration; every `CreateClosure`+`DefineOwnByVal`
writing to the resulting prototype register as a method (static vs.
instance distinguished by whether the target is the prototype object or the
class constructor object itself — not directly exercised in the fixture
read for statics, see `34-class-static-members`, not traced in this pass);
the `Constructor<N>`/`NCFunction<N>` disassembler-role labels as a strong
prior for `classifyFunctions`, though the actual HBC-FORMAT-level signal
backing that label (a `FunctionHeader` flag bit, presumably — not confirmed
which bit) should be identified before relying on the disassembler's own
text output, which this project's decompiler does not consume.

## 5. Writer

Emits `class Name [extends Super] { [fields] constructor(...) {...}
methods... }`, inlining the `<instance_members_initializer>`'s body as the
class's field declarations (`x = 0;` etc.) rather than emitting it as a
call — the call-at-constructor-start is implied by class-field semantics in
JS and does not need to be represented as a visible statement.

## 6. Checker

Beyond stage-A default: asserts the field-initializer call is literally the
first statement of every constructor path recovered (a class with fields
whose initializer runs anywhere else would indicate a matcher
misidentification).

## 7. Version differences

**None to report — this idiom exists only at v99** among this project's
four fetched versions (`versions.txt` in every class fixture documents
v84/v94 rejecting `class` syntax outright, and `34`/`35`/`36`'s
`versions.txt` additionally document that instance/static fields and
accessors specifically require v99, not just "any version that has
`class`" — i.e. there may be a v98-supports-classes-without-fields
intermediate state, not verified here). Static members (`34`) and
getters/setters (`36`) were read as source but not traced to bytecode in
this pass — flagged as the next class-idiom work.
