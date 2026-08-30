/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TODO(T168592126) for now we don't run against shermes,
// since function calls are not checked.

print('generators');;

function* simple() {
  yield 1;
}

try {
  new simple();
  print('must throw');
} catch (e) {
  print('caught', e.name);
}
