/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


print("check array.join");

// Check that side effects do not affect previous array elements.
// The broken version would incorrectly print "!,str,c" here.
var o = {
    toString() {
        arr[0] = "!";
        arr[2] = "c";
        return "str";
    }
}
var arr = ["a", o, "b"];
print(arr.join());
