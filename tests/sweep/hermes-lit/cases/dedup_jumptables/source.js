/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function if_small(x, a, b) {
  switch(x) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      return a;
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
      return b;
  }
}

function if_even(x, a, b) {
  switch(x) {
    case 0:
    case 2:
    case 4:
    case 6:
    case 8:
      return a;
    case 1:
    case 3:
    case 5:
    case 7:
    case 9:
      return b;
  }
}

x=1
print(if_small(x, x + " < 5", x + " > 5"));
print(if_even (x, x + " is even", x + " is odd"));
