/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("private in");

// Simple case.
(function () {
  class A {
    #f1;
    static hasPrivateProp(o) {
      return #f1 in o;
    }
  }
  let inst = new A();
  print(A.hasPrivateProp(inst));
  print(A.hasPrivateProp({}));
  let childInst = Object.create(inst);
  // Searching for a private property does not travel along the prototype chain.
  print(A.hasPrivateProp(childInst));
})();

// Test private names from enclosing scope.
(function () {
  class Outer {
    #f1;
    static getInner() {
      return class {
        static hasOuterPrivate(o) {
          return #f1 in o;
        }
      };
    }
  }
  let Inner = Outer.getInner();
  let outerInst = new Outer();
  print(Inner.hasOuterPrivate(outerInst));
})();

// Proxy can be branded and does not trigger any traps.
(function () {
  class A {
    constructor(o) {
      return o;
    }
  }
  class B extends A {
    #f1;
    static hasPrivateProp(o) {
      return #f1 in o;
    }
  }
  let inst = new B(new Proxy({}, {
    has(target, key) {
      print("has trap called:", key);
      return false;
    }
  }));
  "b" in inst;
  // This does not trigger a proxy trap.
  print(B.hasPrivateProp(inst));
})();
