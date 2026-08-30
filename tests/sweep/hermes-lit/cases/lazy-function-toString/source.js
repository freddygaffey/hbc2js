/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// UNSUPPORTED: serializer

// foo is never called, but its source needs to be reserved ahead of time.
function foo(x) { "show source"; }

(function bar() {
  function baz() { "show source"; return 'baz;' }
    print(foo.toString());
    print(baz.toString());
})()
