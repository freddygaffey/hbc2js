/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



var C = {x: 2}
C[Symbol.hasInstance] = function(o) {
  // 'this' is C.
  // o is the object being tested for.
  print(this.x, o.isC);
  return o.isC;
}

print({isC:true} instanceof C);

print({isC:false} instanceof C);
