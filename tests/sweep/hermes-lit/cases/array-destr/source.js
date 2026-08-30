/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function *iter() {
  for (var i = 0; i < 5; ++i) {
    print(i);
    yield i;
  }
}

print('START');

var [x,y] = iter();
print(x,y);

var [a,b,...[]] = iter();
print(a,b);

var [c,d,...[e,f]] = iter();
print(c,d,e,f);
