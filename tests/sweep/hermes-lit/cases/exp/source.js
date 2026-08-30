/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


'use strict'

print('exponentiation');

print(2 ** 3);
print({valueOf: () => 2} ** 3);

print(2 ** 3 ** 2);
print(2**3**2);
print(2**(3**2));
print((2**3)**2);

print(1 + 2 ** 3 ** 2);
print(2 ** 3 ** 2 + 1);
print(Math.random() ** 0);

var x = 10;
x **= 2;
print(x);

print("a" ** 3 + "b" ** 2);
