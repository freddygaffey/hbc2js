/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */



try {
  print(Uint8Array.from.call(Date, [123]));
} catch (e) {
  print('caught', e.name);
}
