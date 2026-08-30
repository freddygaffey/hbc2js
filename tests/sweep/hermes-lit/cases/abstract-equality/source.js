/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


"use strict";

var str1 = "";
var str2 = "a string";
var str3 = "another string";
var str4 = "another string";
var str5 = str3;
var bigint1 = BigInt(0);
var bigint2 = BigInt(1);
var bigint3 = BigInt(0);
var bigint4 = bigint1;
var obj1 = { field0: "1", toString: () => "obj1" };
var obj2 = { field0: "1", toString: () => "obj2" };
var obj3 = { field0: "1", toString: () => "obj2" };
var obj4 = obj1;
var sym1 =  Symbol("Symbol1");
var sym2 =  Symbol("Symbol2");
var sym3 =  Symbol("Symbol1");
var sym4 =  sym1;

const values = [
    undefined,
    null,
    str1, str2, str3, str4, str5,
    bigint1, bigint2, bigint3, bigint4,
    obj1, obj2, obj3, obj4,
    false, true,
    sym1, sym2, sym3, sym4,
    0.0, 1.0, -NaN, -Infinity,
];

function printValuesAndEqualityValue(i, j) {
    var v0 = values[i];
    var v1 = values[j];
    var s0 = "'" + String(v0) + "'";
    var s1 = "'" + String(v1) + "'";

    print(s0, "("+i+")", s1, "("+j+")", v0 == v1);
}

print("Abstract Equality Test");
for (var i in values) {
    for (var j in values) {
        printValuesAndEqualityValue(i, j);
    }
}

