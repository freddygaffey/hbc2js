/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("super properties");

const obj1 = { prop: 1 };
const obj2 = { prop: 2 };

const c1 = {
  __proto__: obj1,
  printSuperProp() {
    print(super.prop);
  },
};

c1.printSuperProp();

const printSuperProp = c1.printSuperProp;
printSuperProp.call({});

const c2 = { __proto__: obj2, printSuperProp };
c2.printSuperProp();

Object.setPrototypeOf(c1, obj2);

c1.printSuperProp();

printSuperProp.call({});

c2.printSuperProp();

// Verify super propagates through all different function kinds.

const c3 = {
  __proto__: { a: 1, b: 2, c: 3 },
  normal() {
    print(super.a);
    (() => { print(super.b); })();
    (async () => { print(super.c); })();
  },
  *gen() {
    print(super.a);
    (() => { print(super.b); })();
    (async () => { print(super.c); })();
  },
  async asyncFun() {
    print(super.a);
    (() => { print(super.b); })();
    (async () => { print(super.c); })();
  }
};

c3.normal();
c3.gen().next();
c3.asyncFun();

// Test that the receiver is set up correctly for reads.
(function () {
  var parent = {
    x: 10,
    get prop1() {
      print(this.x);
    }
  }
  var child = {
    x: 20,
    foo() {
      super.prop1;
    }
  }
  Object.setPrototypeOf(child, parent);
  child.foo();
})();

// Test that the receiver is set up correctly for writes.
(function () {
  var parent = {
    x: 30,
    set prop1(value) {
      print(this.x);
    }
  }
  var child = {
    x: 40,
    foo() {
      super.prop1 = "value";
    }
  }
  Object.setPrototypeOf(child, parent);
  child.foo();
})();

// Test that super writes throw under correct conditions.

// Should not throw
(function () {
  var parent = {}
  Object.defineProperty(parent, 'prop1', {
    value: 50,
    writable: false
  });
  var child = {
    foo() {
      super.prop1 = "value";
    }
  };
  Object.setPrototypeOf(child, parent);
  // This doesn't throw.
  child.foo();
  print(child.prop1);
  print(parent.prop1);
})();

// Should throw
(function () {
  "use strict";
  var parent = {}
  Object.defineProperty(parent, 'prop1', {
    value: 50,
    writable: false
  });
  var child = {
    foo() {
      super.prop1 = "value";
    }
  };
  Object.setPrototypeOf(child, parent);
  try {
    child.foo();
    print("Fail");
  } catch (e) {
    print("Pass");
  }
})();

// super throws on null prototype.
(function () {
  function key() {
    return "x";
  }
  var obj = {
    reads() {
      try {
        super.x;
        print("read fail");
      } catch (err) {
        print("read threw", err.constructor.name);
      }
      try {
        super[key()];
        print("read fail");
      } catch (err) {
        print("read threw", err.constructor.name);
      }
    },
    writes() {
      try {
        super.x = 42;
        print("write fail");
      } catch (err) {
        print("write threw", err.constructor.name);
      }
      try {
        super[key()] = 42;
        print("write fail");
      } catch (err) {
        print("write threw", err.constructor.name);
      }
    }
  };
  Object.setPrototypeOf(obj, null);
  obj.reads();
  obj.writes();
})();
