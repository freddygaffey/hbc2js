/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Verify property access on transient objects.

print("transient-obj-props");

var xname = "x";

Object.defineProperty(String.prototype, "x", {
    configurable: true,
    get: function() { print("get", typeof(this)); },
    set: function() { print("set", typeof(this)); }
});
'asdf'.x;
'asdf'[eval("xname")];
'asdf'.x = 10;
'asdf'[eval("xname")] = 20;

Object.defineProperty(String.prototype, "x", {
    configurable: true,
    get: function() { "use strict"; print("get", typeof(this)); },
    set: function() { "use strict"; print("set", typeof(this)); }
});
'asdf'.x;
'asdf'[eval("xname")];
'asdf'.x = 10;
'asdf'[eval("xname")] = 20;
