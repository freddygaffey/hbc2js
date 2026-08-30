/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("set-isSupersetOf");

var o1 = {foo: "bar"};
var o2 = {foo: "baz"};
var s1 = new Set([0, 1, 2, 3, 4, o1]);
var s2 = new Set([4, 3, o1, o2]);

var superset = s1.isSupersetOf(s2);
print(superset);

s1 = new Set([0, 1, 2, 3, 4, o1, o2]);
superset = s1.isSupersetOf(s2);
print(superset);

s1 = new Set([2, o2]);
superset = s1.isSupersetOf(s2);
print(superset);

s1 = new Set([0, 1]);
s2 = new Set([0, 1]);
s2.keys = function() {
  print("called keys");
  return [2, 3].values();
}
superset = s1.isSupersetOf(s2);
// s2.has will iterate through [2, 3] instead of its elements [1, 2]
// Thus, the expected result will be false, even if s1 is a superset of s2
print(superset);

// set-like object that encapulates the value [0, 1, 2] with size 3
var setLikeObj = {
  size: 3,
  has(val) {
    print("called has with val: ", val);
    return val === 0 || val === 1 || val === 2;
  },
  keys() {
    print("called keys");
    return [0, 1, 2].values();
  }
};

// s1.size < setLikeObj.size, so return false immediately without iterating
superset = s1.isSupersetOf(setLikeObj);
print(superset);

s1 = new Set([0, 1, 2]);
superset = s1.isSupersetOf(setLikeObj);
print(superset);

s1 = new Set([0, 2, 3]);
superset = s1.isSupersetOf(setLikeObj);
print(superset);

s1 = new Set([0, 1, 3]);
setLikeObj.keys = function(val) {
    print("called keys");
    s1.add(2);
    return [0, 1, 2].values();
}

// 2 was added to s1 by the keys method
superset = s1.isSupersetOf(setLikeObj);
print(s1.size);
print(superset);

setLikeObj.keys = function(val) {
    print("called keys");
    s1.delete(2);
    return [0, 1, 2].values();
}

// 2 was deleted from s1 by the keys method
superset = s1.isSupersetOf(setLikeObj);
print(s1.size);
print(superset);
