// The implicit derived constructor Hermes auto-generates for a class with NO
// constructor of its own but SOME class fields (ECMAScript 15.7.14 step 14,
// same forward as fixture 78's `Implicit`) -- except this time the fields
// are not trivial: `handle` is an arrow class field, so its closure has to
// be created BEFORE `super()` runs and needs access to the constructed
// object once `super()` returns. hermesc compiles that by capturing the
// receiver into the frame's own env slot for the closure to read, THEN
// installing the closure and the plain field onto the receiver, THEN
// returning it -- `r0 = applyArguments(...); _eD_S = r0; r0.handle = handle;
// r0.other = 1; return r0;` -- which is the shape `super-call` refused as
// `R-SC9 func` until now (docs/specs/passes/28-super-call.md section 9.6's
// "Measured..." paragraph): 136 of react-navigation-example-0.85.3's
// refusals were exactly this.
// `C` is the contrast: an EXPLICIT constructor that reads its own rest
// parameter for something besides the forward (`args.length`) forces
// hermesc onto the DIFFERENT spread/apply lowering (`copyRestArgs` + an
// array spread + `applyWithNewTarget`, fixture 78's `Explicit`) rather than
// the `applyArguments` intrinsic, since the intrinsic never materialises the
// argument list at all -- so this rung's forward-fold never even applies to
// it (a plain register-receiver Reflect.construct fold could, but is not
// this section's shape either, since `Explicit` and `C` are refused the same
// way in fixture 78 already).
// What this fixture pins: (a) `B`'s constructor is rebuilt with a real
// `super(...args)` call followed by `this.`-assignments and no
// `__hbc_b_applyArguments` left, (b) `handle`'s own body is untouched and
// still returns the right value once called as `b.handle()`, (c) `C` keeps
// whatever lowering it already had (not this rung's shape either way).
// NOTE: classes are only supported by v98/v99 among the hermesc versions
// this project fetches -- see versions.txt.
class A {
  constructor(x) {
    this.x = x;
  }
}

class B extends A {
  handle = () => this.x;
  other = 1;
  describe() {
    return 'B:' + this.x;
  }
}

class C extends A {
  constructor(...args) {
    super(...args);
    this.y = args.length;
  }
  describe() {
    return 'C:' + this.x;
  }
}

const b = new B(1);
const c = new C(1, 2, 3);
print('b:', b.other, b.handle());
print('c:', c.y, c.x);
print('instanceof:', b instanceof A, c instanceof A);
