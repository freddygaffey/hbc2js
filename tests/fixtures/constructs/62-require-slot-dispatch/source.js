// A Metro-shaped bundle in miniature: the `const m = require(depMap[N])` once
// into a captured (environment) slot, then `m.export(...)` from a nested
// closure convention that dominates real RN bundles
// (docs/specs/17-mcp-harness.md §14.4, docs/specs/hunt-tooling-backlog.md
// "Round 2"). Two modules export the SAME name `run`, so a by-name scan
// cannot tell them apart; the points-to pass must resolve the receiver to
// exactly one of them. The last module's receiver is a parameter and is
// unprovable, so it must yield NO edge at all.
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

// module 0 -- exports `run`.
__d(function (global, require, module, exports, dependencyMap) {
  exports.run = function (x) {
    return 'A:' + x;
  };
}, 0, []);

// module 1 -- ALSO exports `run` (the same-name false-positive class).
__d(function (global, require, module, exports, dependencyMap) {
  exports.run = function (x) {
    return 'B:' + x;
  };
}, 1, []);

// module 2 -- requires module 0 ONCE into a captured slot and calls `run`
// from a nested closure: the shape the points-to pass must resolve.
__d(function (global, require, module, exports, dependencyMap) {
  var a = require(dependencyMap[0]);
  exports.callRun = function (x) {
    return a.run(x);
  };
}, 2, [0]);

// module 3 -- the receiver is a parameter: unprovable, so NO edge.
__d(function (global, require, module, exports, dependencyMap) {
  exports.callUnknown = function (obj) {
    return obj.run(7);
  };
}, 3, [1]);

print(__r(2).callRun('x'));
print(__r(3).callUnknown({
  run: function (n) {
    return n;
  },
}));
