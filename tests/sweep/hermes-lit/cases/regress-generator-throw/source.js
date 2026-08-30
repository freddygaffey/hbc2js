/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Test that a generator that throws is correctly closed.

function* generator() {
  throw Error('fail');
}
var iter = generator();
try { iter.next() } catch {}

print(iter.next().done);
print(iter.next().done);
