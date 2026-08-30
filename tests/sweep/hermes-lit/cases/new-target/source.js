/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function foo() {
    print(typeof new.target, new.target === foo);
}

function bar() {
    return () => new.target;
}

print("start");

foo();
new foo();

var tmp = bar()();
print(typeof tmp, tmp === bar);
var tmp = (new bar())();
print(typeof tmp, tmp === bar);
