/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("regress new");

// We correctly detect that constructing `this` in a construct call leaks its target closure, since it's accessible via `.constructor`.
(function () {
  function target({ a, b }) {
    return a + b;
  }

  function parent() {
    return new target({});
  }

  print(parent().constructor({ a: 10, b: 20 }));
})();
