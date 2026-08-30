/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// REQUIRES: es6_class

class Test {
}


print(Object.getPrototypeOf(Test) === Object.getPrototypeOf(Object));

print(Object.getPrototypeOf(Test.prototype) === Object.prototype);

const obj = new Test();

print(obj.propertyIsEnumerable('test'));
