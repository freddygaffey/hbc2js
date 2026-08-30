/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


var iterable = {};
iterable[Symbol.iterator] = function() {
  return {
    next: function() {
      return {value: [{}, 2], done: false};
    },
    return: function() {
      print('returning');
    },
  };
};
var oldSet = WeakMap.prototype.set;
WeakMap.prototype.set = function() {
  throw new Error('add error');
}
try { new WeakMap(iterable); } catch (e) { print('caught', e.message); }
WeakMap.prototype.set = oldSet;
