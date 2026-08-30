/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('START');

function foo(a, b=1) {
  print(a, b);
}

print(foo.length)
foo(1, 2);
foo(1);

function bar(a, b=1, c) {
  print(a, b);
}

print(bar.length)

function baz(a, b, c) {}

print(baz.length)
