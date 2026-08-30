/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


var proto = {
  m() {
    return ' proto m';
  }
};
var object = {
  get ['a']() { return 'a' + super.m(); },
};
Object.setPrototypeOf(object, proto);
print(object.a);

// Test that accessors without computed names can also refer to super.
(function () {
  let v1 = {
    get a() {
      let x = super.m;
      print(x);
    }
  }
  let parent = { m: 12 };
  v1.a;
  Object.setPrototypeOf(v1, parent);
  v1.a;
})();
