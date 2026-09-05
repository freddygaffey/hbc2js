// Babel's ES-module default-export prologue inside a Metro-shaped mini bundle
// (docs/specs/17-mcp-harness.md section 14.4, docs/BUGS.md "export-side
// resolution"). `export default f` compiles to
//
//     Object.defineProperty(exports, '__esModule', { value: true });
//     exports.default = void 0;          // the hole
//     var _default = ...;
//     exports.default = _default;        // the real write
//
// so the name `default` takes two writes: one proven closure and one value
// the points-to pass cannot prove is a function. Module 0 is the shape where
// last-write-wins is PROVABLE (the void-0 store dominates the closure store,
// which post-dominates it). Module 1 is the same prologue with a CONDITIONAL
// closure store, so `undefined` can still be the last write on some path and
// the pass must keep refusing.
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

// module 0 -- the provable prologue: one void-0 store, then one closure store
// that every exit runs. Resolvable.
__d(function (global, require, module, exports, dependencyMap) {
  Object.defineProperty(exports, '__esModule', { value: true });
  exports.default = void 0;
  var _default = function (x) {
    return 'D:' + x;
  };
  exports.default = _default;
}, 0, []);

// module 1 -- the same prologue, but the closure store is CONDITIONAL: it
// does not post-dominate the void-0 store, so `default` stays unprovable.
__d(function (global, require, module, exports, dependencyMap) {
  Object.defineProperty(exports, '__esModule', { value: true });
  exports.default = void 0;
  if (dependencyMap.length < 1) {
    exports.default = function (x) {
      return 'C:' + x;
    };
  }
}, 1, []);

// module 2 -- requires module 0 once into a captured slot and calls its
// `default` from a nested closure: the shape the widening must resolve.
__d(function (global, require, module, exports, dependencyMap) {
  var a = require(dependencyMap[0]);
  exports.callDefault = function (x) {
    return a.default(x);
  };
}, 2, [0]);

// module 3 -- the same call shape against module 1: NO edge.
__d(function (global, require, module, exports, dependencyMap) {
  var b = require(dependencyMap[0]);
  exports.callDefault = function (x) {
    return b.default(x);
  };
}, 3, [1]);

print(__r(2).callDefault('x'));
print(__r(3).callDefault('y'));
