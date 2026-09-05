// The JS half of the spec-27 L3 JS<->native seam join (docs/specs/
// 27-native-side.md L3, docs/specs/10-artifact-format.md 2.8): the four
// boundary shapes the join reads off the artifact index --
// `NativeModules.<Module>.<method>()` with a native impl, a
// `NativeModules.<Module>` with NO native impl in the APK (the `js-only`
// seam), `TurboModuleRegistry.get("X")` and `requireNativeComponent("Y")`.
//
// Metro-shaped on purpose (docs/BUGS.md 2026-09-05 "seam join links 0/9"):
// a real RN bundle never has `NativeModules` etc. as bare script GLOBALS --
// they are `require()`-BOUND LOCALS read off the module returned by
// `require("react-native")`, from inside a wrapped CommonJS module factory
// (Metro's `__d(factory, id, deps)` convention, same shape as
// `62-require-slot-dispatch/source.js`). The OLD version of this fixture
// declared `var NativeModules = {...}` as a genuine top-level script `var`,
// which Hermes compiles as a real JS-global read/write -- a shape that
// never occurs in a real bundle and let `src/native/seams.ts`'s old
// globals-only anchor pass 100% green while linking 0/9 modules on every
// real app. This fixture instead requires a "react-native" module (id 0)
// ONCE into a captured local (`rn`) inside the app module's factory (id 1),
// then reads `rn.NativeModules.Crypto...` / `rn.TurboModuleRegistry.get(...)`
// / `rn.requireNativeComponent(...)` from NESTED closures -- so those reads
// compile to ordinary `GetById` on a non-global register, landing in
// `index/string-uses.jsonl` as `property-get`, never in `index/globals.jsonl`.
var __hbc_registry = {};
var __hbc_instances = {};

function __d(factory, id, deps) {
  __hbc_registry[id] = { factory: factory, deps: deps };
}

function __r(id) {
  if (__hbc_instances[id]) return __hbc_instances[id].exports;
  var entry = __hbc_registry[id];
  var mod = { exports: {} };
  __hbc_instances[id] = mod;
  entry.factory(this, __r, mod, mod.exports, entry.deps);
  return mod.exports;
}

// module 0 -- stands in for the "react-native" package: the three host
// anchors, each a plain export (never a global).
__d(function (global, require, module, exports, dependencyMap) {
  exports.NativeModules = {
    Crypto: {
      generateKey: function (algo) {
        return 'key(' + algo + ')';
      },
    },
    Missing: {
      foo: function () {
        return 'missing-foo';
      },
    },
  };
  exports.TurboModuleRegistry = {
    get: function (name) {
      return { name: name };
    },
  };
  exports.requireNativeComponent = function (name) {
    return 'component(' + name + ')';
  };
}, 0, []);

// module 1 -- the app module: requires "react-native" ONCE into a captured
// slot (the Babel-interop `var _reactNative = require(...)` shape) and reads
// NativeModules/TurboModuleRegistry/requireNativeComponent as ordinary member
// accesses off it from nested closures -- the real-bundle shape the join
// must resolve.
__d(function (global, require, module, exports, dependencyMap) {
  var rn = require(dependencyMap[0]);
  exports.useCrypto = function () {
    return rn.NativeModules.Crypto.generateKey('aes-256');
  };
  exports.useMissing = function () {
    return rn.NativeModules.Missing.foo();
  };
  exports.useTurbo = function () {
    return rn.TurboModuleRegistry.get('X').name;
  };
  exports.useComponent = function () {
    return rn.requireNativeComponent('Y');
  };
}, 1, [0]);

var app = __r(1);
print(app.useCrypto());
print(app.useMissing());
print(app.useTurbo());
print(app.useComponent());
