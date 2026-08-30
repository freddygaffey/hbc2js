/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Test that different NaN representations get the same hash.
globalThis.zero = 0;
var m = new Map([[NaN, 42]]);
var dynamicNaN = 0 / globalThis.zero;
print(m.get(dynamicNaN));
print(m.has(dynamicNaN));
print(m.get(NaN));
print(m.has(NaN));

m = new Map([[dynamicNaN, 24]]);
print(m.get(dynamicNaN));
print(m.has(dynamicNaN));
print(m.get(NaN));
print(m.has(NaN));
