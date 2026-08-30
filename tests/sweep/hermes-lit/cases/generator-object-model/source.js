/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Testing the chart in ES6.0 25.2.
// Make sure Generators and the functions which surround them have the proper
// inheritance structure.

function *f() {}
var Generator = Object.getPrototypeOf(f);
var GeneratorFunction = Generator.constructor;

print('generator object model');

print(Generator[Symbol.toStringTag]);
print(Generator.prototype[Symbol.toStringTag]);

print(1, GeneratorFunction.prototype === Generator);
print(2, Generator.prototype === Object.getPrototypeOf(f.prototype));
print(3, f instanceof GeneratorFunction);
print(4, Object.getPrototypeOf(Generator) === Function.prototype);
print(5, GeneratorFunction.__proto__ === Function);

var instance = GeneratorFunction();
print(5, typeof instance.prototype);
print(6,
  Object.getPrototypeOf(instance.prototype) ===
  Object.getPrototypeOf(instance).prototype);

var GeneratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf(f())
);
print(GeneratorPrototype[Symbol.toStringTag]);

// If .prototype is null, fall back to generator prototype.
function *g() {}
g.prototype = null;
print(Object.getPrototypeOf(g()) === Generator.prototype);

// f.prototype should not have a .constructor property.
print(Object.getOwnPropertyNames(f.prototype).length);
