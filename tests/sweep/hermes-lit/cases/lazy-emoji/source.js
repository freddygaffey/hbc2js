/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function foo() {
  // There was a crash in UBSAN due to misaligned reads for emoji
  // in lazy compiled string tables.
  print('😀');
}
foo();

