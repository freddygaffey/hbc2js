/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


{
    function promotedFunction(endRecursion) {
        print('F1 start', endRecursion);
        if(!endRecursion) {
            promotedFunction(true);
            return;
        }
        print ('SUCCESS');
        print('F1 end');
    }

    callback = promotedFunction;
}

{
    function promotedFunction(endRecursion) {
        print('F2 start', endRecursion);
        if(!endRecursion) {
            promotedFunction(true);
            return;
        }
        print ('FAIL');
        print('F2 end');
    }
}

callback(false);
