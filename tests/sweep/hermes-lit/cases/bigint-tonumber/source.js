/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


"use strict";

var print = typeof print !== "undefined" ? print : console.log;

function printBigint(b) {
    if (b >= 0) {
        print(` 0x${b.toString(16)}n: ${Number(b)}`);
    } else {
        print(`-0x${(-b).toString(16)}n: ${Number(b)}`);
    }
}

printBigint(0n);

// The largest BigInt that can be converted to Number. The next BigInt can't be
// represented, and thus Number(largestRepresentableBigInt + 1n) is infinity.
var largestRepresentableBigInt =
    (((1n << 53n) - 1n) << (1024n - 53n)) + ((1n << (1024n - 54n)) - 1n);

printBigint(-largestRepresentableBigInt -1n);
printBigint(-largestRepresentableBigInt);

printBigint(largestRepresentableBigInt);
printBigint(largestRepresentableBigInt + 1n);

for (var i = 1n; i < (1n << 1024n); i = (i << 1n)|1n) {
    printBigint(i);
    printBigint(-i);
}

