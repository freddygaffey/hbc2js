/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('promise jobs scheduled in scripts');

setTimeout(_ => print('setTimeout1'), 0);

Promise.resolve()
  .then(_ => print('promise1'))
  .then(_ => {
    print('promise2');

    // Promise jobs enqueued during the current draining.
    Promise.resolve()
      .then(_ => {
        print('promise3')
        setTimeout(_ => print('setTimeout3'), 0);
      }).then(_ => print("promise4"));
  });

setTimeout(_ => print('setTimeout2'), 0);

