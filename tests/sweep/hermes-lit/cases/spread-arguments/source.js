/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('args spread');

function foo(x, y, z) {
  print(x, y, z);
}

foo(...[1,2,3]);
new foo(...[10,20,30]);
foo(...[1], ...[], ...[2,3]);
foo(...[1, 2]);

function myClass(x, y) {
  print(x, y, new.target === myClass);
}
myClass.prototype.property = 101;

myClass(...[4,5]);
F = new myClass(...[4,5]);
print(F.property)

function bar() {
  print(...arguments);
}

bar(1, 2, 3);
