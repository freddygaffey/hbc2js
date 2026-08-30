/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


"use strict";

print('pop');
var a = Array(1,2,3);
print(a.pop(), a.length, a[0], a[1], a[2]);
print(a.pop(), a.length, a[0], a[1], a[2]);
print(a.pop(), a.length, a[0], a[1], a[2]);
print(a.pop(), a.length, a[0], a[1], a[2]);
print(a.pop(), a.length, a[0], a[1], a[2]);

// Pop when length is readonly.
var a = [123];
Object.defineProperty(a, 'length', {writable: false, value: 1});
try { a.pop(); } catch (e) { print(e.name); }

// Pop 'empty' from an array.
var a = [1,2];
delete a[1];
print(a.pop(), a.length);

// Pop from sparse array.
var a = [,,,,10,,,,,];
print(a.pop(), a.length);

// Test recursion of pop re-entering itself.
var a = [];
Object.defineProperty(a, 9, {
  get: Array.prototype.pop,
});
try {
  print(a.pop());
} catch (e) {
  // Infinite recursion, should throw call stack exceeded.
  print(e.name);
}
var a = [];
a[0xFFFFFFFE] = 1;
print(a.length);
print(a.pop());
print(a.length);

var a = {
  0: 12,
  1: 13,
  length: 2,
};
print(Array.prototype.pop.call(a), a.length);
print(Array.prototype.pop.call(a), a.length);
