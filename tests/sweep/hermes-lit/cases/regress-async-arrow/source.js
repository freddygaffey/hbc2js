/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("async arrow");

function foo() {
  return 10;
}

(async (x = foo()) => {
  print (await Promise.resolve("hello"));
})()
