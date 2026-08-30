/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Custom async iterable with error throwing return()
const asyncIterableWithReturnError = {
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
                print('Attempting cleanup...');
                return Promise.reject(new Error('Cleanup error'));
            }
        };
    }
};

// Test for error thrown in the loop with error in return()
(async function testErrorInReturn() {
    try {
        for await (const value of asyncIterableWithReturnError) {
            if (value === 2) {
                throw new Error('Loop error');
            }
            print(value);
        }
    } catch (e) {
        print(e.message);
    }
})();

// Expected Output:
