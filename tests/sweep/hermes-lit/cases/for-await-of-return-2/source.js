/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Custom async iterable
const asyncIterableWithErrorInLoop = {
    [Symbol.asyncIterator]: function() {
        let i = 0;
        return {
            next: function() {
                if (i < 3) {
                    return Promise.resolve({ value: i++, done: false });
                } else {
                    return Promise.resolve({ done: true });
                }
            },
            return: function() {
                print('Cleaning up after error...');
                return Promise.resolve({ done: true });
            }
        };
    }
};

// Test for throwing an error inside the loop
(async function testThrowingErrorInLoop() {
    try {
        for await (const value of asyncIterableWithErrorInLoop) {
            if (value === 2) {
                throw new Error('Intentional Error');
            }
            print(value);
        }
    } catch (e) {
        print(e.message);
    }
})();

// Expected Output:
