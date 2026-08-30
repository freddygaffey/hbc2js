/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("toSorted");

// Basic numeric sort with comparefn.
(function () {
  var arr = [3, 1, 4, 1, 5, 9, 2, 6];
  var sorted = arr.toSorted(function (a, b) { return a - b; });
  print(sorted.join(","));
  // Original unchanged.
  print(arr.join(","));
})();

// Default lexicographic sort (no comparefn).
(function () {
  var arr = [10, 9, 8, 1, 20, 3];
  var sorted = arr.toSorted();
  print(sorted.join(","));
})();

// Empty array.
(function () {
  var arr = [];
  var sorted = arr.toSorted();
  print(sorted.length);
})();

// Single element.
(function () {
  var arr = [42];
  var sorted = arr.toSorted();
  print(sorted.length, sorted[0]);
})();

// Holes become undefined and sort to the end.
(function () {
  var arr = [3, , 1, , 2];
  var sorted = arr.toSorted();
  print(sorted.length);
  print(sorted[0], sorted[1], sorted[2], sorted[3], sorted[4]);
})();

// Sparse array-like objects become dense sorted arrays without changing the
// receiver.
(function () {
  var len = 10000;
  var obj = {};
  obj.prop = "prop";
  obj[0] = 100;
  obj[5] = undefined;
  obj[len - 1] = 0;
  obj.length = len;

  var sorted = Array.prototype.toSorted.call(obj);
  print(sorted.length);
  print(sorted[0], sorted[1], sorted[2], sorted[len - 1]);
  print(Object.prototype.hasOwnProperty.call(sorted, 2));
  print(obj[0], obj[5], obj[len - 1], obj.prop, obj.length);
})();

// Array-like objects via .call.
(function () {
  var obj = {0: "banana", 1: "apple", 2: "cherry", length: 3};
  var sorted = Array.prototype.toSorted.call(obj);
  print(sorted.join(","));
  print(Array.isArray(sorted));
})();

// TypeError for non-callable comparefn.
(function () {
  try {
    [1, 2].toSorted(42);
    print("FAIL: no error");
  } catch (e) {
    print(e.constructor.name);
  }
})();

// comparefn returning NaN is treated as +0.
(function () {
  var arr = [3, 1, 2];
  var sorted = arr.toSorted(function () { return NaN; });
  print(sorted.join(","));
  print(arr.join(","));
})();

// comparefn that mutates the original array does not affect the result.
(function () {
  var arr = [5, 3, 1, 4, 2];
  var sorted = arr.toSorted(function (a, b) {
    arr.length = 0;
    return a - b;
  });
  print(sorted.join(","));
  print(arr.length);
})();

// Function.length and Function.name.
(function () {
  print(Array.prototype.toSorted.length);
  print(Array.prototype.toSorted.name);
})();
