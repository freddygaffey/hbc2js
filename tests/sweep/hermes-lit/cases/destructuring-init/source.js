/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('initializers in destructuring');

var {abc = function() {}} = {};
print(abc.name);
var {['abc']: def = function() {}} = {};
print(def.name);

var [foo = function() {}, bar = function() {}] = [];
print(foo.name, bar.name);

var {[undefined]: x = 1, ...x} = 1;
print(typeof(x));

var {[null]: y = 1, ...y} = 1;
print(typeof(y));
