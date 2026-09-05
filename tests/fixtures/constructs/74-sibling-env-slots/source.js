// A Metro-shaped lazy re-export barrel whose factory keeps its five exported
// values in captured variables (one environment slot each, read back through
// per-name getters), plus two small predicates that capture NOTHING and whose
// identical bodies are shared by hermesc between creation sites in two
// different nested functions.
//
// docs/BUGS.md 2026-09-05 "Residual `diff:LoadFromEnvironment(imm)` bucket".
// A function that captures nothing and is created from more than one function
// has no single home (src/emit/index.ts F24-5), so it stays an orphan; when
// `--split` writes the module file it must pull that orphan's declaration
// into the factory, because the factory body names it. `src/split/index.ts`
// used to prepend those declarations to the factory body, ahead of the
// factory's own `let _e<env>_<slot>` prologue. Hermes allocates a scope's
// environment slots in TEXTUAL declaration order (hoisting moves the closure
// creation, not the slot), so two prepended declarations pushed every one of
// the barrel's own slots up by two and every getter recompiled with a slot
// immediate two higher than the original -- exactly the uniform +2 seen on
// react-navigation-example module 681 / fn#683.
//
// The invariant this fixture pins: splitting this module and recompiling the
// module file must reproduce the ORIGINAL getter slot immediates
// (tests/gate/split/orphan-decl-order.test.ts).
var __hbc_registry = {};

function __d(factory, id, deps) {
  __hbc_registry[id] = { factory: factory, deps: deps };
}

__d(function (global, require, module, exports, dependencyMap) {
  "use strict";
  var alpha, beta, gamma, delta, epsilon;
  Object.defineProperty(exports, "alpha", { enumerable: true, get: function () { return alpha; } });
  Object.defineProperty(exports, "beta", { enumerable: true, get: function () { return beta; } });
  Object.defineProperty(exports, "gamma", { enumerable: true, get: function () { return gamma; } });
  Object.defineProperty(exports, "delta", { enumerable: true, get: function () { return delta; } });
  Object.defineProperty(exports, "epsilon", { enumerable: true, get: function () { return epsilon; } });
  alpha = function (arr) { return arr.every(function (x) { return typeof x === "number" && !isNaN(x); }); };
  beta = function (arr) { return arr.some(function (x) { return typeof x === "number" && !isNaN(x); }); };
  gamma = function (arr) { return arr.filter(function (y) { return Array.isArray(y) && y.length === 4; }); };
  delta = function (arr) { return arr.map(function (y) { return Array.isArray(y) && y.length === 4; }); };
  epsilon = function (n) { return alpha([n]) && gamma([[n]]).length; };
}, 0, []);

var entry = __hbc_registry[0];
var mod = { exports: {} };
entry.factory(globalThis, null, mod, mod.exports, entry.deps);

print(mod.exports.alpha([1, 2, 3]));
print(mod.exports.alpha([1, NaN]));
print(mod.exports.beta(['a', 4]));
print(mod.exports.gamma([[1, 2, 3, 4], [5], 'no']).length);
print(mod.exports.delta([[1, 2, 3, 4], [5]]).join(','));
print(mod.exports.epsilon(7));
