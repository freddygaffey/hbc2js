/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


var obj = {};

obj[Symbol.toStringTag] = "MyFavoriteObject";
print(obj.toString());

// Not a string, use "Object" instead.
obj[Symbol.toStringTag] = 123;
print(obj.toString());

// Ensure the override works for built-ins as well.
Boolean.prototype[Symbol.toStringTag] = 'asdf';
print(Object.prototype.toString.call(true));

print((new Int8Array(10))[Symbol.toStringTag]);
