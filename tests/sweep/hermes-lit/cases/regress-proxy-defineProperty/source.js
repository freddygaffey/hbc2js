/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Check to ensure that the defineProperty/getOwnPropertyDescriptor
// trap correctly receives either a string or symbol as its
// parameter.
let p = new Proxy({}, {
  defineProperty(target, property, attributes) {
    print(typeof property)
  },
  getOwnPropertyDescriptor(target, property){
    print(typeof property);
  }
})

// getOwnPropertyDescriptor is called as well during setting
// of properties, so expect both print statements to be run.
p.test = 1

p[Symbol('test')] = 1

Object.getOwnPropertyDescriptor(p, 'prop');

Object.getOwnPropertyDescriptor(p, Symbol('prop'));
