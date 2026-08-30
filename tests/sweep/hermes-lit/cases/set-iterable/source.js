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
      return {value: 1, done: false};
    },
    return: function() {
      print('returning');
    },
  };
};
var oldAdd = Set.prototype.add;
Set.prototype.add = function() {
  throw new Error('add error');
}
try { new Set(iterable); } catch (e) { print('caught', e.message); }
Set.prototype.add = oldAdd;
