/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function f() {}

var obj = {
  __proto__: f,
  b: 12
};

for (var i in obj) {
  print(i, obj[i]);
}
