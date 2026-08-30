/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// This test exercises an issue found in LowerArgumentsArray in which PHI nodes
// were not being properly updated.
function decrementArguments(flag) {
  while (flag) {
    flag = flag - 1;
    var var1 = (() => (var3 = 123))();
    var var3 = arguments;
  }
  return var3 - 1 + flag;
}

print(decrementArguments(2));

