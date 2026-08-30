/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


var x = {
  10n: 'a',
  1_1n: 'b',
};

print("bigint as object key");

print(x[10]);
print(x[11]);

