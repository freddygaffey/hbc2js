/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function init() {
    print("init");
    return {
        get "a"() {
            print("get a()");
            return "this is a";
        },
        get b() {
            print("get b()");
            return "this is b";
        },
        get c() {
            print("get c()");
            return "this is c";
        },
    };
}

function keyA() {
    print("keyA")
    return "a";
}

function keyB() {
    print("keyB")
    return "b";
}

var valObj = {};
function val() {
    print("val")
    return valObj;
}

({[keyA()]: val().a, c: val().c, [keyB()]: val().b} = init());

print(JSON.stringify(valObj));
