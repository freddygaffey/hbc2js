/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print('optional chaining');

var a = undefined;
var b = {
  x: 1,
  y: function(arg) {
    return arg;
  },
  getThis: function() {
    return this;
  }
};

function foo() {
  print('foo called');
  return 50;
}

print(a?.x);
print(b?.x);

print(a?.(42));
print(a?.(foo()));
print(a?.y?.(42));
print(a?.b.c);
print(a?.b().c);
print(a?.b?.().c);
print(a?.().b);

print(b?.y(42));
print(b?.y?.(42));
print(b.y?.(foo()));
print(b?.y(foo()));
print(b?.y?.(foo()));
print(b?.z?.(42));
print(b?.getThis?.(42) === b);
print((b.getThis)?.(42) === b);
print((b?.getThis)?.(42) === b);

var obj = {
  a: {b: 3}
};
print(obj?.a?.b);
print(delete obj?.a?.b);
print(obj?.a?.b);
print(delete obj?.a?.b);
print(obj?.a?.b);
print(delete obj?.a);
print(obj?.a?.b);
