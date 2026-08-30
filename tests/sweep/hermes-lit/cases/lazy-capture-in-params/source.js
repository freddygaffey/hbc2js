/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


(function main() {
  var x = 'outside';
  var paramsFunc;

  function foo(
    _ = (paramsFunc = function bar() {
      // Capture the outer 'x'
      return x;
    })
  ) {
    let x = 'inside';
  }
  foo();

  print(paramsFunc());
})();

(function arrowCapture() {
  var x = 'outside';
  var paramsFunc;

  function foo(
    _ = (paramsFunc = () => {
      // Capture the outer 'x'
      return x;
    })
  ) {
    let x = 'inside';
  }
  foo();

  print(paramsFunc());
})();

(function setCapture() {
  var x = 'outside';
  var probeParams;

  var obj = {
    set a(_ = probeParams = function() { return x; }) {
      var x = 'inside';
    }
  };
  // Force default params on setter to trigger.
  obj.a = undefined;

  print(probeParams());
})();
