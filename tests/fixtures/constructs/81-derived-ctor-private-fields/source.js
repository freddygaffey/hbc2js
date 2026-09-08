// The EXPLICIT derived constructor -- `constructor(a) { super(a); ... }` --
// carrying a private field, which is the combination no earlier fixture pins.
// Fixture 33 has the explicit `super(...)` shape without private names;
// fixture 76 has private fields in a BASE class; fixture 80 has private-name-
// free field installs after the IMPLICIT `applyArguments` forward.
// What the private field changes, and what this fixture exists to pin
// (docs/specs/passes/28-super-call.md section 10):
//   (a) hermesc runs short of registers and reuses ONE for both the class
//       load and the getPrototypeOf result -- `r2 = _e0_1; r2 =
//       Object.getPrototypeOf(r2);` -- where fixture 33 uses two. The rung
//       used to resolve the class binding by searching back from the super
//       site, find that self-overwriting store again, and refuse R-SC1.
//   (b) the brand check hermesc emits for `#x` writes the stand-in register
//       one more time (`r2 = __hbc_b_throwTypeError("Cannot initialize
//       private field twice."); throw ...;`), a store no path can read, which
//       the rung used to count as a real write and refuse R-SC4.
// A regression in either shows up here as a `Reflect.construct` that survives
// in B's constructor.
// NOTE: classes are only supported by v98/v99 among the hermesc versions
// this project fetches -- see versions.txt.
class A {
  constructor(a) {
    this.base = a;
  }
}

class B extends A {
  #x = 1;
  constructor(a) {
    super(a);
    this.y = a;
  }
  get x() {
    return this.#x;
  }
}

const b = new B(7);
print('b:', b.base, b.y, b.x);
print('instanceof:', b instanceof A);
