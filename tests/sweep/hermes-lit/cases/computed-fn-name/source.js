/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Tests for SetFunctionName with computed property names.

print("computed function names");

// Opaque identity function to prevent the optimizer from constant-folding
// computed string keys back into static property names.
function k(s) { return s; }

var sym = Symbol("desc");
var symEmpty = Symbol();

var obj = {
  [k("f")]: function() {},
  [sym]: () => {},
  get [k("g")]() {},
  set [k("s")](v) {},
};
print(obj["f"].name);
print(obj[sym].name);
print(JSON.stringify(Object.getOwnPropertyDescriptor(obj, "g").get.name));
print(JSON.stringify(Object.getOwnPropertyDescriptor(obj, "s").set.name));

// Symbol() and Symbol("") edge cases (tested once here).
var symEmptyDesc = Symbol("");
var objSym = {
  [symEmpty]: function() {},
  [symEmptyDesc]: function() {},
};
print(JSON.stringify(objSym[symEmpty].name));
print(objSym[symEmptyDesc].name);

class C1 {
  [k("m")]() {}
  [sym]() {}
  static [k("sm")]() {}
  get [k("g")]() {}
  set [k("s")](v) {}
}
print(C1.prototype["m"].name);
print(C1.prototype[sym].name);
print(C1["sm"].name);
print(Object.getOwnPropertyDescriptor(C1.prototype, "g").get.name);
print(Object.getOwnPropertyDescriptor(C1.prototype, "s").set.name);

// Instance fields with computed key.
class C2 {
  [k("strFunc")] = function() {};
  [k("strArrow")] = () => {};
  [k("strClass")] = class {};
  [k("strNamedFunc")] = function myFunc() {};
  [sym] = function() {};
}
var c2 = new C2();

print(c2["strFunc"].name);
print(c2["strArrow"].name);
print(c2["strClass"].name);
print(c2["strNamedFunc"].name);
print(c2[sym].name);

// Static fields with computed key.
class C3 {
  static [k("strStaticFunc")] = function() {};
  static [sym] = () => {};
  static [k("strStaticNamedFunc")] = function myFunc() {};
}

print(C3["strStaticFunc"].name);
print(C3[sym].name);
print(C3["strStaticNamedFunc"].name);
