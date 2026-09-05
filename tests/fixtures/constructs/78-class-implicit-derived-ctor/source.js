// The IMPLICIT derived constructor (ECMAScript 15.7.14 step 14) next to the
// explicit `constructor(...a) { super(...a); }` an author could write instead.
// hermesc lowers them DIFFERENTLY, which is the point of this fixture:
//   * `Implicit` gets a constructor whose whole body is the forward
//       return applyArguments(arguments, getPrototypeOf(<the class>), undefined, new.target)
//     -- the shape `super-call` refused as R-SC6 until 2026-09-05 and now
//     rebuilds as `constructor(...args) { super(...args); }`
//     (docs/specs/passes/28-super-call.md section 9);
//   * `Explicit` gets the spread super call instead (copyRestArgs, an array
//     spread and applyWithNewTarget), which is NOT this rung's shape and stays
//     refused (docs/BUGS.md, the R-SC7 spread/apply row).
// What this fixture pins: (a) `Implicit`'s constructor is the rebuilt
// `constructor(...args) { super(...args); }` with no `__hbc_b_applyArguments`
// and no `"use strict"` directive left (a non-simple parameter list may not
// carry one; a class body is strict already), (b) `Explicit` keeps its own
// distinct lowering, (c) `Base`'s constructor and both derived classes'
// methods are untouched.
// NOTE: classes are only supported by v98/v99 among the hermesc versions this
// project fetches -- see versions.txt.
class Base {
  constructor(name, size) {
    this.name = name;
    this.size = size;
  }
  describe() {
    return this.name + ':' + this.size;
  }
}

class Implicit extends Base {
  louder() {
    return this.describe().toUpperCase();
  }
}

class Explicit extends Base {
  constructor(...a) {
    super(...a);
  }
  louder() {
    return this.describe().toUpperCase();
  }
}

const i = new Implicit('box', 3);
const e = new Explicit('crate', 4);
print('implicit:', i.describe(), i.louder());
print('explicit:', e.describe(), e.louder());
print('instanceof:', i instanceof Base, e instanceof Base);
print('args:', new Implicit('one').describe(), new Explicit('two').describe());
