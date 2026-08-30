/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('error cause');

try {
  try {
    throw Error("err1");
  } catch (e1) {
    throw Error("err2", { cause: e1 });
  }
} catch (e2) {
  print(e2.message);
  print(e2.cause.message);
}

try {
  throw Error("err", {get cause() {
    print('getter');
    return 'foo';
  }});
} catch (e) {
  print(e.message);
  print(e.cause);
}

try {
  throw Error("err", {});
} catch (e) {
  print(e.message);
  print(Object.hasOwnProperty(e, 'cause'));
}
