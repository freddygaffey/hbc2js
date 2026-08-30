/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function testTrap(trap, callback){
  var handler = {
    x: 5,
    // Make this a getter to revoke the proxy once the JSProxy method has started.
    // The handler should be read before the trap is called.
    get [trap]() {
      // Print to make sure the trap actually is executing.
      print(trap);
      revoke();
      return function(){
        // This should receive the correct handler, even though the proxy has been revoked.
        print(this.x);
      };
    }
  };

  // We give a function as the target to the proxy so
  // that the [[Call]] and [[Construct]] handlers are setup.
  let { proxy, revoke } = Proxy.revocable(function(){}, handler);
  // There are some cases where more operations are done on the proxy after
  // it is revoked, which throws an error. That's fine, we are just checking
  // to make sure the process doesn't crash.
  try {
    callback(proxy);
  } catch(e){
  }
}


let base = {};
testTrap("setPrototypeOf", proxy => Object.setPrototypeOf(proxy, base));
testTrap("getPrototypeOf", Object.getPrototypeOf);
testTrap("isExtensible", Object.isExtensible);
testTrap("preventExtensions", Object.preventExtensions);
testTrap("getOwnPropertyDescriptor", proxy => Object.getOwnPropertyDescriptor(proxy, 'prop'));
testTrap("defineProperty", proxy => proxy.hi = 1);
testTrap("has", proxy => 'prop' in proxy);
testTrap("get", proxy => proxy.prop);
testTrap("set", proxy => proxy.prop = 1);
testTrap("deleteProperty", proxy => delete proxy.prop);
testTrap("ownKeys", Object.getOwnPropertyNames);
testTrap("apply", proxy => proxy(1));
testTrap("construct", proxy => new proxy(1));
