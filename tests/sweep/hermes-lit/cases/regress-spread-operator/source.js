/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Check that the spread operator behaves correctly when modifying the
// underlying hidden class while iterating over an object's properties in order
// to copy it.

var obj = {
  get foo() {
    this.tutu = 'hi';
    delete obj.bar;
    obj.tutu = 'lol';
  },
   bar: 'bar'
};
print({ ...obj }.tutu)

var obj2 = {
  get foo() {
    obj2.bar = 'foo'
  },
  bar: 'bar'
};
print({ ...obj2 }.bar)
