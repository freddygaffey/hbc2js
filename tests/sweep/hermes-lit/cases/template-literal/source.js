/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print(`hello${1 + 1}world`);
print(`world`);
print('world' + `` + 'hello');
print(`${666}`);
print(`begin${`first${`second`}firstend`}end`);
var num = 99;
print(`${111 + 222}${num > 100 ? 'big' : 'small'}`);
print(`first line\nsecond line`);
function func(x) {
  return x > 0;
}
print(`positive? ${func(10)}`);

var obj = { toString() { return 'tostr'; }, valueOf(){ return 'value'; } }
print(`${obj}`)
