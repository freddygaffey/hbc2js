/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function typeAndValue(v) {
    return `${typeof v} ${v}`
}

try
{
  print(typeAndValue(BigInt.asUintN(9007199254740991,-2187269391n)));
} catch (e) {
  print(e.name);
}

print(typeAndValue(BigInt.asUintN(9007199254740991,2187269391n)));
