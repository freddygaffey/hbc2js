/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('promise jobs scheduled in tasks');

setTimeout(_ => {
  print('task1')
  Promise.resolve().then(_ => print('promise in task1'))
  setTimeout(_ => print('task3'), 0);
}, 0);

setTimeout(_ => {
  print('task2')
  setTimeout(_ => print('task4'), 0);
  Promise.resolve().then(_ => print('promise in task2'))
}, 0);

